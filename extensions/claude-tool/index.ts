/**
 * Claude Tool — Invoke Claude Code from within pi
 *
 * Registers a `claude` tool that delegates tasks to Claude Code via the
 * @anthropic-ai/claude-agent-sdk. Claude Code has web search, file access,
 * bash, code editing, and all built-in tools. Results stream back live.
 *
 * ## Session Persistence
 *
 * Every invocation creates a persistent Claude Code session stored at:
 *   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 *
 * Sessions are indexed locally in .pi/claude-sessions.json (last 50) with
 * prompt, model, timestamp, cost, and turns for quick lookup.
 *
 * To resume or inspect a session later:
 *   claude --resume <session-id>          # interactive
 *   claude -p "follow up" --resume <id>   # non-interactive
 *
 * The session ID is shown in the tool's live progress and final output,
 * and also available in the tool result details for other agents to use.
 *
 * ## Concurrency
 *
 * Multiple claude tool calls can run in parallel. Each invocation has its
 * own isolated state (text buffer, tool tracking, abort controller).
 * No shared mutable state between calls.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function formatDuration(ms: number): string {
	const secs = Math.floor(ms / 1000);
	if (secs < 60) return `${secs}s`;
	const mins = Math.floor(secs / 60);
	const rem = secs % 60;
	return `${mins}m${rem.toString().padStart(2, "0")}s`;
}

function countTokensApprox(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Compress ["WebFetch","WebFetch","WebFetch","Read","Read"] → "WebFetch×3 → Read×2" */
function compressToolChain(tools: string[]): string {
	if (tools.length === 0) return "";
	const groups: { name: string; count: number }[] = [];
	for (const tool of tools) {
		const last = groups[groups.length - 1];
		if (last && last.name === tool) {
			last.count++;
		} else {
			groups.push({ name: tool, count: 1 });
		}
	}
	return groups
		.map((g) => (g.count > 1 ? `${g.name}×${g.count}` : g.name))
		.join(" → ");
}

/** Append a session record to .pi/claude-sessions.json */
function indexSession(cwd: string, record: {
	sessionId: string;
	prompt: string;
	model?: string;
	timestamp: string;
	elapsed: number;
	cost: number;
	turns: number;
}) {
	try {
		const dir = join(cwd, ".pi");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "claude-sessions.json");
		let sessions: any[] = [];
		try {
			sessions = JSON.parse(readFileSync(file, "utf-8"));
		} catch {}
		sessions.push(record);
		if (sessions.length > 50) sessions = sessions.slice(-50);
		writeFileSync(file, JSON.stringify(sessions, null, 2) + "\n");
	} catch {}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "claude",
		label: "Claude Code",
		description:
			`Invoke Claude Code to perform autonomous tasks: web research, code analysis, file operations, or anything Claude Code can do. ` +
			`Claude Code has built-in tools for web search, file reading/writing, bash, and more. ` +
			`Use this when you need Claude Code's capabilities (especially web search) or want to delegate a self-contained task. ` +
			`The result is streamed back live. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. ` +
			`Set outputFile to write the result to a file instead of returning it inline — saves tokens in your context. ` +
			`The file can be read later by you or handed off to a subagent.`,

		parameters: Type.Object({
			prompt: Type.String({ description: "The task or question for Claude Code" }),
			model: Type.Optional(
				Type.String({
					description: 'Model to use (default: "sonnet"). Examples: "sonnet", "opus", "haiku"',
				})
			),
			maxTurns: Type.Optional(
				Type.Number({
					description: "Maximum number of agentic turns (default: 30)",
				})
			),
			systemPrompt: Type.Optional(
				Type.String({
					description: "Additional system prompt instructions to append",
				})
			),
			outputFile: Type.Optional(
				Type.String({
					description:
						"Write result to this file instead of returning inline. " +
						"Saves tokens in your context. Use when the result is large or " +
						"will be consumed by a subagent later (e.g. '.pi/research.md').",
				})
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { prompt, model, maxTurns, systemPrompt, outputFile } = params;
			const startTime = Date.now();

			const abortController = new AbortController();
			if (signal) {
				signal.addEventListener("abort", () => abortController.abort());
			}

			const options: Record<string, any> = {
				abortController,
				cwd: ctx.cwd,
				maxTurns: maxTurns ?? 30,
				permissionMode: "bypassPermissions",
				persistSession: true,
				includePartialMessages: true,
			};

			if (model) options.model = model;
			if (systemPrompt) options.appendSystemPrompt = systemPrompt;

			let fullText = "";
			let cost = 0;
			let turns = 0;
			let sessionId = "";
			let sessionModel = "";
			let toolUses: string[] = [];
			// Track phase: "thinking" → "tools" → "responding"
			// Only show token count during "responding" (final answer streaming)
			let phase: "thinking" | "tools" | "responding" = "thinking";
			// Count only tokens from the final response segment
			let responseText = "";

			function emitUpdate() {
				onUpdate?.({
					content: [{ type: "text", text: fullText }],
					details: {
						streaming: true,
						startTime,
						responseTokens: countTokensApprox(responseText),
						phase,
						toolUses: [...toolUses],
						cost,
						sessionId,
						sessionModel,
					},
				});
			}

			emitUpdate();

			try {
				const conversation = query({ prompt, options });

				for await (const message of conversation) {
					if (signal?.aborted) break;

					// Capture session ID from init message
					if (message.type === "system" && (message as any).subtype === "init") {
						sessionId = (message as any).session_id ?? "";
						sessionModel = (message as any).model ?? "";
						emitUpdate();
						continue;
					}

					// Token-by-token streaming
					if (message.type === "stream_event") {
						const delta = (message as any).event?.delta;
						if (delta?.type === "text_delta" && delta.text) {
							fullText += delta.text;
							responseText += delta.text;
							if (phase !== "responding") {
								phase = "responding";
							}
							emitUpdate();
						}
						continue;
					}

					// Track tool usage — resets response tracking for next segment
					if (message.type === "assistant") {
						for (const block of (message as any).message?.content ?? []) {
							if (block.type === "tool_use") {
								toolUses.push(block.name);
								phase = "tools";
								// Reset response token counter — next text segment is a new response
								responseText = "";
								emitUpdate();
							}
						}
					}

					if (message.type === "result") {
						cost = (message as any).total_cost_usd ?? 0;
						turns = (message as any).num_turns ?? 0;
						if (!sessionId) sessionId = (message as any).session_id ?? "";
						if (!fullText && (message as any).result) {
							fullText = (message as any).result;
						}
					}
				}
			} catch (err: any) {
				if (err.name === "AbortError" || signal?.aborted) {
					return {
						content: [{ type: "text", text: fullText || "(cancelled)" }],
						details: { cancelled: true, cost, elapsed: Date.now() - startTime, sessionId },
					};
				}
				return {
					content: [{ type: "text", text: `Error: ${err.message}` }],
					details: { error: err.message },
					isError: true,
				};
			}

			const elapsed = Date.now() - startTime;

			// Index the session for later lookup
			if (sessionId) {
				indexSession(ctx.cwd, {
					sessionId,
					prompt: prompt.slice(0, 200),
					model: sessionModel || model,
					timestamp: new Date().toISOString(),
					elapsed,
					cost,
					turns,
				});
			}

			if (!fullText.trim()) {
				return {
					content: [{ type: "text", text: "(no response from Claude Code)" }],
					details: { cost, turns, elapsed, sessionId },
				};
			}

			const totalTokens = countTokensApprox(fullText);

			// Write to file instead of returning inline — saves context tokens
			if (outputFile) {
				try {
					const outPath = outputFile.startsWith("/")
						? outputFile
						: join(ctx.cwd, outputFile);
					const outDir = join(outPath, "..");
					mkdirSync(outDir, { recursive: true });
					writeFileSync(outPath, fullText);

					const summary =
						`Result written to ${outputFile} (~${totalTokens} tokens, ${formatSize(Buffer.byteLength(fullText))}).\n` +
						`Session: ${sessionId}`;

					return {
						content: [{ type: "text", text: summary }],
						details: {
							cost,
							turns,
							sessionId,
							sessionModel,
							elapsed,
							tokens: totalTokens,
							toolUses,
							outputFile,
						},
					};
				} catch (err: any) {
					// Fall through to inline return if write fails
				}
			}

			const truncation = truncateHead(fullText, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			let resultText = truncation.content;
			if (truncation.truncated) {
				resultText += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
			}

			return {
				content: [{ type: "text", text: resultText }],
				details: {
					cost,
					turns,
					sessionId,
					sessionModel,
					elapsed,
					tokens: totalTokens,
					toolUses,
					truncated: truncation.truncated,
				},
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("claude "));
			const prompt = args.prompt?.length > 100 ? args.prompt.slice(0, 100) + "…" : args.prompt;
			text += theme.fg("accent", `"${prompt}"`);
			if (args.model) text += theme.fg("dim", ` model=${args.model}`);
			if (args.maxTurns) text += theme.fg("dim", ` maxTurns=${args.maxTurns}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as any;

			// ── Live progress while streaming ──
			if (isPartial) {
				const elapsed = details?.startTime ? formatDuration(Date.now() - details.startTime) : "…";
				const responseTokens = details?.responseTokens ?? 0;
				const tools = (details?.toolUses ?? []) as string[];
				const cost = details?.cost ?? 0;
				const sid = details?.sessionId ?? "";
				const phase = details?.phase ?? "thinking";

				let status = theme.fg("warning", "⟳ Claude Code");
				status += theme.fg("dim", ` ${elapsed}`);
				if (cost > 0) status += theme.fg("dim", ` $${cost.toFixed(4)}`);

				// Show token count only when the final response is streaming
				if (phase === "responding" && responseTokens > 0) {
					status += theme.fg("dim", ` ~${responseTokens} tokens`);
				}

				// Phase-specific status
				if (phase === "thinking") {
					status += theme.fg("dim", " thinking…");
				} else if (phase === "tools") {
					status += theme.fg("dim", " working…");
				}

				if (tools.length > 0) {
					status += "\n" + theme.fg("dim", `  tools: ${compressToolChain(tools)}`);
				}

				if (sid) {
					status += "\n" + theme.fg("dim", `  session: ${sid}`);
				}

				return new Text(status, 0, 0);
			}

			// ── Final result ──
			if (details?.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			if (details?.cancelled) {
				let text = theme.fg("warning", "Cancelled");
				if (details.sessionId) text += theme.fg("dim", ` session: ${details.sessionId}`);
				return new Text(text, 0, 0);
			}

			let header = theme.fg("success", "✓ Claude Code");
			if (details?.elapsed) header += theme.fg("dim", ` ${formatDuration(details.elapsed)}`);
			if (details?.tokens) header += theme.fg("dim", ` ~${details.tokens} tokens`);
			if (details?.cost) header += theme.fg("dim", ` $${details.cost.toFixed(4)}`);
			if (details?.turns) header += theme.fg("dim", ` ${details.turns} turns`);
			if (details?.truncated) header += theme.fg("warning", " (truncated)");

			if (details?.toolUses?.length > 0) {
				header += "\n" + theme.fg("dim", `  tools: ${compressToolChain(details.toolUses)}`);
			}

			if (details?.outputFile) {
				header += "\n" + theme.fg("accent", `  → ${details.outputFile}`);
			}

			if (details?.sessionId) {
				header += "\n" + theme.fg("dim", `  session: ${details.sessionId}`);
			}

			if (details?.outputFile) {
				// File mode: no inline content, just the summary
				return new Text(header, 0, 0);
			}

			if (!expanded) {
				const firstLine = result.content[0]?.type === "text" ? result.content[0].text.split("\n")[0] : "";
				const preview = firstLine.length > 120 ? firstLine.slice(0, 120) + "…" : firstLine;
				header += "\n" + theme.fg("dim", preview);
				return new Text(header, 0, 0);
			}

			const content = result.content[0]?.type === "text" ? result.content[0].text : "";
			return new Text(header + "\n" + content, 0, 0);
		},
	});
}
