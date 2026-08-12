// dcg-guard.ts — block destructive shell commands with dcg
// https://github.com/Dicklesworthstone/destructive_command_guard
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DCG_BIN = process.env.DCG_BIN ?? join(homedir(), ".local", "bin", "dcg");
const DCG_TIMEOUT_MS = 2_000;

function dcgDecision(
  command: string,
): Promise<{ deny: boolean; reason: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (decision: { deny: boolean; reason: string }) => {
      if (settled) return;
      settled = true;
      resolve(decision);
    };

    const child = spawn(DCG_BIN, ["--robot", "test", command], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: DCG_TIMEOUT_MS,
    });

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.on("error", (error) => {
      finish({
        deny: true,
        reason: `Blocked because dcg could not run: ${error.message}`,
      });
    });

    child.on("close", (code, signal) => {
      if (code === 0) {
        finish({ deny: false, reason: "" });
        return;
      }

      if (code === 1 || code === 2) {
        let reason =
          code === 1
            ? "Blocked by dcg (destructive command)."
            : "Blocked by dcg pending human review.";
        try {
          const parsed = JSON.parse(stdout) as {
            reason?: unknown;
            rule_id?: unknown;
          };
          if (typeof parsed.reason === "string") reason = parsed.reason;
          if (typeof parsed.rule_id === "string")
            reason += ` [${parsed.rule_id}]`;
        } catch {
          // Keep the default reason when dcg returns malformed JSON.
        }
        finish({ deny: true, reason });
        return;
      }

      const failure = signal
        ? `terminated by ${signal}`
        : `exited with code ${code ?? "unknown"}`;
      finish({ deny: true, reason: `Blocked because dcg ${failure}.` });
    });
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const command = String(event.input?.command ?? "");
    if (!command.trim()) return;

    const { deny, reason } = await dcgDecision(command);
    if (deny) {
      return { block: true, reason };
    }
  });
}
