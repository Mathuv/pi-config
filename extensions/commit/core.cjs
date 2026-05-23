const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const SKILL_TEXT_MAX_BYTES = 24 * 1024;
const STATUS_MAX_CHARS = 12 * 1024;
const DIFF_MAX_CHARS = 48 * 1024;
const VALID_TYPES = new Set(["feat", "fix", "docs", "refactor", "chore", "test", "perf"]);
const DEFAULT_SKILL_PATH = path.join(os.homedir(), ".pi", "agent", "skills", "commit", "SKILL.md");

function truncateText(text, maxChars, label) {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[${label} truncated at ${maxChars} characters]`;
}

function stripFrontmatter(text) {
	const normalized = text.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) return normalized;
	const end = normalized.indexOf("\n---\n", 4);
	if (end === -1) return normalized;
	return normalized.slice(end + "\n---\n".length);
}

function sanitizeSkillText(text) {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > SKILL_TEXT_MAX_BYTES) {
		throw new Error(`Commit skill policy is too large (${bytes} bytes > ${SKILL_TEXT_MAX_BYTES} bytes)`);
	}

	const sanitized = stripFrontmatter(text).trim();
	if (!sanitized) {
		throw new Error("Commit skill policy is empty after sanitization");
	}
	return sanitized;
}

async function loadCommitSkill(skillPath = DEFAULT_SKILL_PATH) {
	let raw;
	try {
		raw = await fs.readFile(skillPath, "utf8");
	} catch (error) {
		throw new Error(`Unable to read commit skill policy at ${skillPath}: ${error.message}`);
	}
	return sanitizeSkillText(raw);
}

function splitCommitMessage(text) {
	const normalized = text.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	const subjectIndex = lines.findIndex((line) => line.trim().length > 0);
	if (subjectIndex === -1) return { subject: "" };

	const subject = lines[subjectIndex].trim();
	const body = lines.slice(subjectIndex + 1).join("\n").trim();
	return body ? { subject, body } : { subject };
}

function validateCommitMessage(text) {
	const { subject } = splitCommitMessage(text);
	if (!subject) return { ok: false, error: "Commit subject is required" };
	if (subject.endsWith(".")) return { ok: false, error: "Commit subject must not end with a period" };

	const match = /^(\w+)(?:\(([^)]+)\))?:\s+(.+)$/.exec(subject);
	if (!match) {
		return { ok: false, error: "Commit subject must match <type>(<scope>): <summary>" };
	}

	const [, type, _scope, summary] = match;
	if (!VALID_TYPES.has(type)) {
		return { ok: false, error: `Commit type must be one of: ${Array.from(VALID_TYPES).join(", ")}` };
	}
	if (!summary.trim()) return { ok: false, error: "Commit summary is required" };
	if (summary.length > 72) return { ok: false, error: "Commit summary must be <= 72 characters" };
	if (/^Signed-off-by:/im.test(text)) return { ok: false, error: "Commit message must not include Signed-off-by" };
	if (/^BREAKING[ -]CHANGE:/im.test(text)) return { ok: false, error: "Commit message must not include breaking-change markers" };

	return { ok: true };
}

function buildCommitArgs(message) {
	const args = ["commit", "-m", message.subject];
	if (message.body) args.push("-m", message.body);
	return args;
}

function extractStagedStatus(status) {
	return status
		.replace(/\r\n/g, "\n")
		.split("\n")
		.filter((line) => line.length >= 2 && line[0] !== " " && line[0] !== "?")
		.join("\n")
		.trim();
}

function extractTextContent(response) {
	return (response.content ?? [])
		.filter((part) => part && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function buildGenerationPrompt({ skillText, stagedStatus, stagedDiff, guidance }) {
	const sections = [
		"Generate a git commit message for the staged changes only.",
		"Return only the commit message text: subject line, optional blank line, optional body.",
		"Do not include markdown fences, explanations, sign-offs, breaking-change footers, or push instructions.",
		"",
		"## Commit policy from ~/.pi/agent/skills/commit/SKILL.md",
		skillText,
		"",
		"## Staged status",
		stagedStatus || "(no staged status lines)",
		"",
		"## Staged diff",
		stagedDiff || "(no staged diff output)",
	];

	const trimmedGuidance = guidance.trim();
	if (trimmedGuidance) {
		sections.push("", "## User guidance", trimmedGuidance);
	}

	return sections.join("\n");
}

async function assertGitRepo(pi) {
	const result = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"]);
	if (result.code !== 0 || result.stdout.trim() !== "true") {
		throw new Error("Not inside a git work tree");
	}
}

async function hasStagedChanges(pi) {
	const result = await pi.exec("git", ["diff", "--cached", "--quiet", "--exit-code"]);
	if (result.code === 0) return false;
	if (result.code === 1) return true;
	throw new Error((result.stderr || result.stdout || "git diff --cached failed").trim());
}

async function getStagedContext(pi) {
	const statusResult = await pi.exec("git", ["status", "--porcelain=v1"]);
	if (statusResult.code !== 0) {
		throw new Error((statusResult.stderr || statusResult.stdout || "git status failed").trim());
	}

	const diffResult = await pi.exec("git", ["diff", "--cached", "--no-ext-diff", "--no-color", "--unified=3"]);
	if (diffResult.code !== 0) {
		throw new Error((diffResult.stderr || diffResult.stdout || "git diff --cached failed").trim());
	}

	return {
		stagedStatus: truncateText(extractStagedStatus(statusResult.stdout), STATUS_MAX_CHARS, "staged status"),
		stagedDiff: truncateText(diffResult.stdout.trim(), DIFF_MAX_CHARS, "staged diff"),
	};
}

async function getAuth(ctx) {
	if (!ctx.model) throw new Error("No model selected");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok || !auth.apiKey) {
		throw new Error(auth.ok ? `No API key for ${ctx.model.provider}` : auth.error);
	}
	return auth;
}

async function generateCommitMessage(ctx, complete, auth, prompt) {
	const response = await complete(
		ctx.model,
		{
			systemPrompt: "You write concise Conventional Commit messages from git diffs.",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: prompt }],
					timestamp: Date.now(),
				},
			],
		},
		{ apiKey: auth.apiKey, headers: auth.headers },
	);

	const text = extractTextContent(response);
	if (!text) throw new Error("Model returned an empty commit message");
	return text;
}

async function reviewCommitMessage(ctx, initialText) {
	let draft = initialText;
	while (true) {
		const edited = await ctx.ui.editor("Edit commit message", draft);
		if (edited === undefined) return undefined;

		const validation = validateCommitMessage(edited);
		if (validation.ok) return splitCommitMessage(edited);

		ctx.ui.notify(validation.error, "error");
		draft = edited;
	}
}

function formatCommitFailure(result) {
	const output = [result.stderr, result.stdout].filter((part) => part && part.trim()).join("\n").trim();
	return output || `git commit failed with exit code ${result.code}`;
}

async function runCommitCommand(pi, ctx, mode, args = "", deps = {}) {
	const modeLabel = mode === "all" ? "all" : "staged";
	if (!ctx.hasUI) {
		ctx.ui.notify("commit commands require interactive UI", "error");
		return;
	}

	let skillText;
	let auth;
	try {
		await assertGitRepo(pi);
		skillText = await loadCommitSkill(deps.skillPath);
		auth = await getAuth(ctx);
	} catch (error) {
		ctx.ui.notify(error.message, "error");
		return;
	}

	if (mode === "all") {
		const addResult = await pi.exec("git", ["add", "-A"]);
		if (addResult.code !== 0) {
			ctx.ui.notify((addResult.stderr || addResult.stdout || "git add -A failed").trim(), "error");
			return;
		}
	}

	let staged;
	try {
		staged = await hasStagedChanges(pi);
	} catch (error) {
		ctx.ui.notify(error.message, "error");
		return;
	}

	if (!staged) {
		ctx.ui.notify(mode === "all" ? "No changes to commit after git add -A" : "No staged changes to commit", "info");
		return;
	}

	let generated;
	try {
		ctx.ui.setStatus?.("commit", "Generating commit message...");
		const stagedContext = await getStagedContext(pi);
		const prompt = buildGenerationPrompt({ skillText, guidance: args, ...stagedContext });
		generated = await generateCommitMessage(ctx, deps.complete, auth, prompt);
	} catch (error) {
		ctx.ui.notify(error.message, "error");
		return;
	} finally {
		ctx.ui.setStatus?.("commit", undefined);
	}

	const message = await reviewCommitMessage(ctx, generated);
	if (!message) {
		ctx.ui.notify("Commit cancelled", "info");
		return;
	}

	const commitResult = await pi.exec("git", buildCommitArgs(message));
	if (commitResult.code !== 0) {
		ctx.ui.notify(formatCommitFailure(commitResult), "error");
		return;
	}

	const hashResult = await pi.exec("git", ["rev-parse", "--short", "HEAD"]);
	const hash = hashResult.code === 0 ? hashResult.stdout.trim() : "unknown";
	ctx.ui.notify(`Committed ${modeLabel} changes ${hash}: ${message.subject}`, "info");
}

function registerCommitCommands(pi, deps) {
	pi.registerCommand("commit-staged", {
		description: "Generate, review, and commit the currently staged changes",
		handler: async (args, ctx) => runCommitCommand(pi, ctx, "staged", args ?? "", deps),
	});

	pi.registerCommand("commit-all", {
		description: "Stage all changes, then generate, review, and commit them",
		handler: async (args, ctx) => runCommitCommand(pi, ctx, "all", args ?? "", deps),
	});
}

module.exports = {
	registerCommitCommands,
	runCommitCommand,
	__test__: {
		SKILL_TEXT_MAX_BYTES,
		STATUS_MAX_CHARS,
		DIFF_MAX_CHARS,
		buildCommitArgs,
		buildGenerationPrompt,
		extractStagedStatus,
		sanitizeSkillText,
		splitCommitMessage,
		truncateText,
		validateCommitMessage,
	},
};
