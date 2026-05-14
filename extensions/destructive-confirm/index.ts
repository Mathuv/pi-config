/**
 * Destructive Action Confirmation Extension
 *
 * Intercepts `bash`, `write`, and `edit` tool calls to detect
 * destructive operations (file deletion, SQL DML/DDL, HTTP DELETE,
 * destructive git/CLI ops, paths outside cwd) and gating with
 * explicit user confirmation.
 *
 * Commands:
 *   /destructive-confirm — toggle protection on/off
 *   /dc                — alias for the above
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";

// ─── Risk Types ────────────────────────────────────────────────────────────────

export type RiskCategory = "bash" | "write" | "edit";
export type RiskSeverity = "high" | "medium" | "low";

export interface Risk {
  category: RiskCategory;
  severity: RiskSeverity;
  description: string;
}

// ─── Bash Risk Detection ───────────────────────────────────────────────────────

interface BashRule {
  pattern: RegExp;
  severity: RiskSeverity;
  description: string;
}

const bashRules: BashRule[] = [
  // Destructive SQL — check before generic file ops since TRUNCATE overlaps
  { pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i, severity: "high", description: "Destructive SQL DROP" },
  { pattern: /\bDELETE\s+FROM\b/i, severity: "high", description: "Destructive SQL DELETE FROM" },
  { pattern: /\bUPDATE\s+\w+\s+SET\b/i, severity: "high", description: "Destructive SQL UPDATE" },
  { pattern: /\bTRUNCATE\s+\w+\b/i, severity: "high", description: "Destructive SQL TRUNCATE" },

  // File deletion
  { pattern: /\brm\s+-rf?\b/i, severity: "high", description: "Recursive file deletion" },
  { pattern: /\brm\b/i, severity: "high", description: "File deletion" },
  { pattern: /\bshred\b/i, severity: "high", description: "File shredding" },
  { pattern: /\btruncate\b/i, severity: "high", description: "File truncation" },

  // HTTP DELETE via curl
  { pattern: /\bcurl\b.*(?:-X\s+DELETE|--request\s+DELETE)\b/i, severity: "medium", description: "HTTP DELETE request" },

  // Destructive git ops — no \b before dashes (dashes are non-word chars)
  { pattern: /\bgit\s+reset\b.*--hard\b/i, severity: "high", description: "Destructive git reset --hard" },
  { pattern: /\bgit\s+push\b.*(?:--force|-f)\b/i, severity: "high", description: "Force git push" },
  { pattern: /\bgit\s+branch\b.*(?:-D|--delete)\b/i, severity: "high", description: "Delete git branch" },
  { pattern: /\bgit\s+commit\b.*--amend\b/i, severity: "low", description: "Git commit --amend" },

  // Destructive CLI verbs — require delete to have an argument (excludes "help delete")
  { pattern: /\bgcloud\b.*\s+delete\s+\S+/i, severity: "medium", description: "gcloud resource deletion" },
  { pattern: /\bkubectl\b.*\bdelete\b/i, severity: "high", description: "Kubernetes resource deletion" },
  { pattern: /\bjira\b.*\bdelete\b/i, severity: "medium", description: "Jira resource deletion" },
  { pattern: /\bgh\s+pr\b.*\b(close|merge|delete)\b/i, severity: "medium", description: "GitHub PR modification" },
];

/**
 * Detect destructive patterns in a bash command string.
 * Returns a `Risk` on the first match, or `undefined` if the command is safe.
 */
export function detectBashRisk(command: string): Risk | undefined {
  for (const rule of bashRules) {
    if (rule.pattern.test(command)) {
      return { category: "bash", severity: rule.severity, description: rule.description };
    }
  }
  return undefined;
}

// ─── Path Risk Detection ───────────────────────────────────────────────────────

/** Resolve a possibly-relative path against a working directory. */
export function resolveAbsolutePath(cwd: string, filePath: string): string {
  return path.resolve(cwd, filePath);
}

/** Check whether a path resolves inside (or equal to) the cwd subtree. */
export function isWithinCwd(cwd: string, filePath: string): boolean {
  const resolved = path.resolve(cwd, filePath);
  const normalizedCwd = path.resolve(cwd);
  const relative = path.relative(normalizedCwd, resolved);
  // Only treat true parent traversal as outside cwd:
  // - relative === ".."  (parent directory itself)
  // - relative.startsWith(".." + path.sep)  (path into parent, e.g. "../foo")
  // This avoids false positives for valid in-cwd names like "..hidden.txt".
  return !(relative === ".." || relative.startsWith(".." + path.sep));
}

/**
 * Detect whether a write/edit path falls outside the working directory.
 * Returns a `Risk` if outside cwd, or `undefined` if the path is safe.
 */
export function detectPathRisk(
  cwd: string,
  toolName: "write" | "edit",
  filePath: string,
): Risk | undefined {
  if (!isWithinCwd(cwd, filePath)) {
    return {
      category: toolName,
      severity: "high",
      description: `File operation outside working directory: ${filePath}`,
    };
  }
  return undefined;
}

// ─── Confirmation Gate ─────────────────────────────────────────────────────────

/** Options for the confirmation select dialog. */
export const CONFIRM_TIMEOUT = 15_000;

/**
 * Options for gating a destructive tool call.
 */
export interface GateOptions {
  /** Timeout in milliseconds. When undefined, no timeout is applied. */
  timeoutMs?: number;
}

/**
 * Gate a destructive tool call through user confirmation.
 *
 * @param risk - The detected risk.
 * @param hasUI - Whether the session has a UI (interactive mode).
 * @param selectFn - Function to show a select dialog.
 * @param options - Gate options. Omitted waits indefinitely.
 * @returns `{ block: true, reason }` to block, `{ block: false }` to allow once,
 *          or `{ block: false, disableForSession: true }` to allow + disable.
 */
export async function gateToolCall(
  risk: Risk,
  hasUI: boolean,
  selectFn: (
    label: string,
    options: string[],
    opts?: { timeout?: number },
  ) => Promise<string | undefined>,
  options: GateOptions = {},
): Promise<
  { block: true; reason: string }
  | { block: false }
  | { block: false; disableForSession: true }
> {
  if (!hasUI) {
    return { block: true, reason: `Blocked: [${risk.category}] ${risk.description} (non-interactive mode)` };
  }

  const selectOpts = options.timeoutMs === undefined ? undefined : { timeout: options.timeoutMs };

  const choice = await selectFn(
    `⚠️  ${risk.description}\n\nAllow this action?`,
    ["Deny (default)", "Allow once", "Allow and disable protection for this session…"],
    selectOpts,
  );

  if (choice === "Allow and disable protection for this session…") {
    const secondChoice = await selectFn(
      `⚠️  ${risk.description}\n\nDisable protection for the rest of this session?`,
      ["Cancel (keep protection on)", "Yes, allow and disable for session"],
      selectOpts,
    );

    if (secondChoice === "Yes, allow and disable for session") {
      return { block: false, disableForSession: true };
    }

    return { block: true, reason: `Blocked: [${risk.category}] ${risk.description} (cancelled disable)` };
  }

  if (choice !== "Allow once") {
    return { block: true, reason: `Blocked: [${risk.category}] ${risk.description} (denied)` };
  }

  return { block: false };
}

export default function destructiveConfirmExtension(pi: ExtensionAPI): void {
  let enabled = true;
  let timeoutEnabled = false;

  function updateStatus(ctx: ExtensionContext): void {
    if (!enabled) {
      ctx.ui.setStatus("destructive-confirm", "🔓 DC");
    } else if (timeoutEnabled) {
      ctx.ui.setStatus("destructive-confirm", ctx.ui.theme.fg("warning", "🔒⏱ DC"));
    } else {
      ctx.ui.setStatus("destructive-confirm", ctx.ui.theme.fg("warning", "🔒∞ DC"));
    }
  }

  function toggle(ctx: ExtensionContext): void {
    enabled = !enabled;
    if (enabled) {
      ctx.ui.notify("Destructive confirmation enabled");
    } else {
      ctx.ui.notify("Destructive confirmation disabled");
    }
    updateStatus(ctx);
  }

  function toggleTimeout(ctx: ExtensionContext): void {
    timeoutEnabled = !timeoutEnabled;
    if (timeoutEnabled) {
      ctx.ui.notify("Destructive confirmation timeout enabled");
    } else {
      ctx.ui.notify("Destructive confirmation timeout disabled");
    }
    updateStatus(ctx);
  }

  pi.registerCommand("destructive-confirm", {
    description: "Toggle destructive action confirmation",
    handler: async (_args, ctx) => toggle(ctx),
  });

  pi.registerCommand("dc", {
    description: "Toggle destructive action confirmation (alias)",
    handler: async (_args, ctx) => toggle(ctx),
  });

  pi.registerCommand("destructive-confirm-timeout", {
    description: "Toggle destructive confirmation timeout",
    handler: async (_args, ctx) => toggleTimeout(ctx),
  });

  pi.registerCommand("dc-timeout", {
    description: "Toggle destructive confirmation timeout (alias)",
    handler: async (_args, ctx) => toggleTimeout(ctx),
  });

  pi.on("session_start", async (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!enabled) return undefined;

    let risk: Risk | undefined;

    if (event.toolName === "bash") {
      risk = detectBashRisk((event.input as { command: string }).command);
    } else if (event.toolName === "write") {
      risk = detectPathRisk(ctx.cwd, "write", (event.input as { path: string }).path);
    } else if (event.toolName === "edit") {
      risk = detectPathRisk(ctx.cwd, "edit", (event.input as { path: string }).path);
    }

    if (!risk) return undefined;

    const gateOptions = timeoutEnabled ? { timeoutMs: CONFIRM_TIMEOUT } : {};

    const result = await gateToolCall(
      risk,
      ctx.hasUI,
      (label, options, opts) => ctx.ui.select(label, options, opts),
      gateOptions,
    );

    if (result.block) {
      return { block: true, reason: result.reason };
    }

    if ("disableForSession" in result && result.disableForSession) {
      enabled = false;
      updateStatus(ctx);
      ctx.ui.notify("Destructive confirmation disabled for this session", "warning");
    }

    return undefined;
  });
}
