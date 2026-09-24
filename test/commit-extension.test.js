const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const core = require("../extensions/commit/core.cjs");

const { __test__, runCommitCommand } = core;

async function withSkillFile(content, fn) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-commit-ext-"));
	const skillPath = path.join(dir, "SKILL.md");
	await fs.writeFile(skillPath, content, "utf8");
	try {
		return await fn(skillPath);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function makeCtx({ hasUI = true, editorResults = ["feat(commit): add staged commit command"], authOk = true } = {}) {
	const notifications = [];
	const ctx = {
		hasUI,
		cwd: "/repo",
		model: { provider: "test", id: "model" },
		modelRegistry: {
			async getApiKeyAndHeaders() {
				ctx.authCalls += 1;
				return authOk ? { ok: true, apiKey: "key", headers: { "x-test": "1" } } : { ok: false, error: "no auth" };
			},
		},
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
			async editor(_title, initialText) {
				ctx.editorInputs.push(initialText);
				return editorResults.shift();
			},
			setStatus() {},
		},
		authCalls: 0,
		editorInputs: [],
		notifications,
	};
	return ctx;
}

function makePi(execImpl) {
	const calls = [];
	return {
		calls,
		async exec(command, args) {
			calls.push([command, args]);
			return execImpl(command, args, calls);
		},
	};
}

function ok(stdout = "") {
	return { code: 0, stdout, stderr: "" };
}

function fail(code = 1, stderr = "") {
	return { code, stdout: "", stderr };
}

test("validates Conventional Commit messages deterministically", () => {
	assert.deepEqual(__test__.validateCommitMessage("feat(commit): add commit helper"), { ok: true });
	assert.equal(__test__.validateCommitMessage("add commit helper").ok, false);
	assert.equal(__test__.validateCommitMessage("feat: add commit helper.").ok, false);
	assert.equal(__test__.validateCommitMessage(`feat(${"scope".repeat(12)}): short summary`).ok, true);
	assert.equal(__test__.validateCommitMessage("feat: " + "x".repeat(73)).ok, false);
	assert.equal(__test__.validateCommitMessage("feat: add helper\n\nSigned-off-by: Me").ok, false);
	assert.equal(__test__.validateCommitMessage("feat: add helper\n\nBREAKING CHANGE: nope").ok, false);
});

test("splits subject and body into argv-safe git commit arguments", () => {
	const message = "\nfeat(commit): add review gate\n\nExplain why.\n";
	assert.deepEqual(__test__.splitCommitMessage(message), {
		subject: "feat(commit): add review gate",
		body: "Explain why.",
	});
	assert.deepEqual(__test__.buildCommitArgs({ subject: "fix: handle cancel", body: "Abort safely." }), [
		"commit",
		"-m",
		"fix: handle cancel",
		"-m",
		"Abort safely.",
	]);
});

test("sanitizes commit skill frontmatter and rejects empty or oversize policy", () => {
	assert.equal(__test__.sanitizeSkillText("---\nname: commit\n---\n\n# Commit\nUse format."), "# Commit\nUse format.");
	assert.throws(() => __test__.sanitizeSkillText("---\nname: commit\n---\n"), /empty/i);
	assert.throws(() => __test__.sanitizeSkillText("x".repeat(__test__.SKILL_TEXT_MAX_BYTES + 1)), /too large/i);
});

test("filters porcelain status to staged entries only", () => {
	const status = "M  staged.ts\n M unstaged.ts\nA  added.ts\n?? new.ts\nD  deleted.ts\n";
	assert.equal(__test__.extractStagedStatus(status), "M  staged.ts\nA  added.ts\nD  deleted.ts");
});

test("/commit-staged never stages files and commits edited staged message", async () => {
	await withSkillFile("# Commit skill\nUse Conventional Commits.", async (skillPath) => {
		let completePrompt = "";
		const ctx = makeCtx({ editorResults: ["feat(commit): add staged command"] });
		const pi = makePi(async (_command, args) => {
			const key = args.join(" ");
			if (key === "rev-parse --is-inside-work-tree") return ok("true\n");
			if (key === "diff --cached --quiet --exit-code") return fail(1);
			if (key === "status --porcelain=v1") return ok("M  staged.ts\n M unstaged.ts\n?? new.ts\n");
			if (key.startsWith("diff --cached")) return ok("diff --git a/staged.ts b/staged.ts\n");
			if (key === "commit -m feat(commit): add staged command") return ok("[main abc123] feat(commit): add staged command\n");
			if (key === "rev-parse --short HEAD") return ok("abc123\n");
			throw new Error(`unexpected git args: ${key}`);
		});

		await runCommitCommand(pi, ctx, "staged", "prefer extension scope", {
			skillPath,
			complete: async (_model, request) => {
				completePrompt = request.messages[0].content[0].text;
				return { content: [{ type: "text", text: "feat(commit): add staged command" }] };
			},
		});

		assert.equal(pi.calls.some(([, args]) => args.join(" ") === "add -A"), false);
		assert.match(completePrompt, /M  staged\.ts/);
		assert.doesNotMatch(completePrompt, /unstaged\.ts|new\.ts/);
		assert.deepEqual(pi.calls.at(-2), ["git", ["commit", "-m", "feat(commit): add staged command"]]);
	});
});

test("/commit-all checks auth before staging and keeps staging on editor cancel", async () => {
	await withSkillFile("# Commit skill\nUse Conventional Commits.", async (skillPath) => {
		const ctx = makeCtx({ editorResults: [undefined] });
		const sequence = [];
		const pi = makePi(async (_command, args) => {
			sequence.push(args.join(" "));
			const key = args.join(" ");
			if (key === "rev-parse --is-inside-work-tree") return ok("true\n");
			if (key === "add -A") return ok();
			if (key === "diff --cached --quiet --exit-code") return fail(1);
			if (key === "status --porcelain=v1") return ok("A  new.ts\n");
			if (key.startsWith("diff --cached")) return ok("diff --git a/new.ts b/new.ts\n");
			throw new Error(`unexpected git args: ${key}`);
		});

		await runCommitCommand(pi, ctx, "all", "", {
			skillPath,
			complete: async () => ({ content: [{ type: "text", text: "feat(commit): add all command" }] }),
		});

		assert.equal(ctx.authCalls, 1);
		assert.equal(sequence.indexOf("add -A") > sequence.indexOf("rev-parse --is-inside-work-tree"), true);
		assert.equal(pi.calls.some(([, args]) => args[0] === "reset"), false);
		assert.equal(pi.calls.some(([, args]) => args[0] === "commit"), false);
	});
});

test("empty staged index exits before LLM editor or commit", async () => {
	await withSkillFile("# Commit skill\nUse Conventional Commits.", async (skillPath) => {
		const ctx = makeCtx();
		let completeCalled = false;
		const pi = makePi(async (_command, args) => {
			const key = args.join(" ");
			if (key === "rev-parse --is-inside-work-tree") return ok("true\n");
			if (key === "diff --cached --quiet --exit-code") return ok();
			throw new Error(`unexpected git args: ${key}`);
		});

		await runCommitCommand(pi, ctx, "staged", "", {
			skillPath,
			complete: async () => {
				completeCalled = true;
				return { content: [] };
			},
		});

		assert.equal(completeCalled, false);
		assert.equal(ctx.editorInputs.length, 0);
		assert.equal(pi.calls.some(([, args]) => args[0] === "commit"), false);
	});
});

test("invalid edited messages reopen editor until valid", async () => {
	await withSkillFile("# Commit skill\nUse Conventional Commits.", async (skillPath) => {
		const ctx = makeCtx({ editorResults: ["bad message", "fix(commit): validate edited message"] });
		const pi = makePi(async (_command, args) => {
			const key = args.join(" ");
			if (key === "rev-parse --is-inside-work-tree") return ok("true\n");
			if (key === "diff --cached --quiet --exit-code") return fail(1);
			if (key === "status --porcelain=v1") return ok("M  index.ts\n");
			if (key.startsWith("diff --cached")) return ok("diff --git a/index.ts b/index.ts\n");
			if (key === "commit -m fix(commit): validate edited message") return ok();
			if (key === "rev-parse --short HEAD") return ok("def456\n");
			throw new Error(`unexpected git args: ${key}`);
		});

		await runCommitCommand(pi, ctx, "staged", "", {
			skillPath,
			complete: async () => ({ content: [{ type: "text", text: "feat(commit): draft" }] }),
		});

		assert.deepEqual(ctx.editorInputs, ["feat(commit): draft", "bad message"]);
		assert.equal(pi.calls.some(([, args]) => args.join(" ") === "commit -m fix(commit): validate edited message"), true);
	});
});
