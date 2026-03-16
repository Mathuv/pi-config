import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { highlightCode, getLanguageFromPath, keyHint } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const PREVIEW_LINES = 10;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "write_artifact",
    label: "Write Artifact",
    description:
      "Write a session-scoped artifact file (plan, context, research, notes, etc.). " +
      "Files are stored under ~/.pi/history/<project>/artifacts/<session-id>/. " +
      "Use this instead of writing pi working files directly.",
    promptGuidelines: [
      "Use write_artifact for any pi working file: plans, scout context, research notes, reviews, or other session artifacts.",
      "The name param can include subdirectories (e.g. 'context/auth-flow.md').",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Filename, e.g. 'plan.md' or 'context/auth-flow.md'" }),
      content: Type.String({ description: "File content" }),
    }),

    renderCall(args, theme) {
      const name = args.name ?? "...";
      const content = args.content ?? "";

      let text = theme.fg("toolTitle", theme.bold("write_artifact")) + " " + theme.fg("accent", name);

      if (content) {
        const lang = getLanguageFromPath(name);
        const lines = lang ? highlightCode(content, lang) : content.split("\n");
        const totalLines = lines.length;
        // During streaming, show preview
        const displayLines = lines.slice(0, PREVIEW_LINES);
        const remaining = totalLines - PREVIEW_LINES;

        text += "\n\n" + displayLines.map((line: string) => (lang ? line : theme.fg("toolOutput", line))).join("\n");

        if (remaining > 0) {
          text += theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total)`);
        }
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as { path?: string; name?: string; content?: string } | undefined;
      const name = details?.name ?? "artifact";
      const content = details?.content ?? "";

      let text = theme.fg("success", "✓") + " " + theme.fg("accent", details?.path ?? name);

      if (content) {
        const lang = getLanguageFromPath(name);
        const lines = lang ? highlightCode(content, lang) : content.split("\n");
        const totalLines = lines.length;
        const maxLines = expanded ? lines.length : PREVIEW_LINES;
        const displayLines = lines.slice(0, maxLines);
        const remaining = totalLines - maxLines;

        text += "\n\n" + displayLines.map((line: string) => (lang ? line : theme.fg("toolOutput", line))).join("\n");

        if (remaining > 0) {
          text +=
            theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total,`) +
            ` ${keyHint("expandTools", "to expand")})`;
        }
      }

      return new Text(text, 0, 0);
    },

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const project = basename(ctx.cwd);
      const sessionId = ctx.sessionManager.getSessionId();
      const artifactDir = join(homedir(), ".pi", "history", project, "artifacts", sessionId);
      const filePath = resolve(artifactDir, params.name);

      // Safety: ensure we're not escaping the artifact directory
      if (!filePath.startsWith(artifactDir)) {
        throw new Error(`Path escapes artifact directory: ${params.name}`);
      }

      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, params.content, "utf-8");

      return {
        content: [{ type: "text", text: `Artifact written to: ${filePath}` }],
        details: { path: filePath, name: params.name, sessionId, content: params.content },
      };
    },
  });
}
