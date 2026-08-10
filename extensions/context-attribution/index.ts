/**
 * Standalone /context_attribution extension entry point.
 *
 * This file wires the approved observer hooks to the private attribution
 * ledger and registers exactly one command. The extension adds no context
 * and performs no persistent write. Every raw runtime value stays inside
 * the hook call that received it; the ledger receives only attributeContext
 * output and safe model metadata.
 *
 * The before_provider_request handler never reads the payload. The extension
 * never registers after_provider_response or tool_result for content capture.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  attributeContext,
  classifyPromptSource,
  keyedDigest,
  matchSkillPathDigest,
  type PromptSource,
} from "./attribution.ts";
import { sanitizeLabel } from "./estimate.ts";
import { createAttributionLedger } from "./ledger.ts";
import { showContextAttribution } from "./render.ts";
import type { SourceEstimate } from "./types.ts";

export default function contextAttributionExtension(pi: ExtensionAPI): void {
  const ledger = createAttributionLedger();

  let systemRows: SourceEstimate[] | undefined;
  let systemPromptDigest: string | undefined;
  let promptSource: PromptSource | undefined;
  let currentPromptDigest: string | undefined;
  let skillPathDigests: Map<string, string> | undefined;
  const skillReads = new Map<string, string>();

  /** Clears all per-run capture state. The ledger keeps its own state. */
  function clearCapture(): void {
    systemRows = undefined;
    systemPromptDigest = undefined;
    promptSource = undefined;
    currentPromptDigest = undefined;
    skillPathDigests = undefined;
    skillReads.clear();
  }

  /** Builds keyed skill-path digests for the read-tool skill boundary. */
  function captureSkillDigests(skills: unknown, key: string): void {
    skillPathDigests = new Map();
    if (!Array.isArray(skills)) return;
    for (const skill of skills) {
      if (!skill || typeof skill !== "object") continue;
      const record = skill as Record<string, unknown>;
      const filePath = typeof record.filePath === "string" ? record.filePath : "";
      const name = typeof record.name === "string" ? record.name : "";
      if (filePath.length === 0) continue;
      skillPathDigests.set(keyedDigest(filePath, key), sanitizeLabel(name));
    }
  }

  pi.on("session_start", (event) => {
    clearCapture();
    ledger.observeSessionStart(event.reason);
  });

  pi.on("input", (event) => {
    ledger.observeInput(event.source);
    // A streaming steer or followUp delivers no new before_agent_start and
    // must not relabel the original prompt classification.
    if (event.streamingBehavior === undefined) {
      promptSource = classifyPromptSource(event.text, pi.getCommands());
    }
  });

  pi.on("before_agent_start", (event) => {
    const key = ledger.getDigestKey();
    if (typeof key !== "string") return;
    // Convert the raw system options to sanitized numeric rows inside this
    // hook call. Only the rows, digests, and safe labels cross the boundary.
    systemRows = attributeContext({
      system: {
        systemPrompt: event.systemPrompt,
        options: event.systemPromptOptions,
        matchesCurrent: true,
      },
      messages: [],
      activeTools: [],
      allTools: [],
    });
    systemPromptDigest = keyedDigest(event.systemPrompt, key);
    currentPromptDigest = keyedDigest(event.prompt, key);
    captureSkillDigests(event.systemPromptOptions.skills, key);
  });

  pi.on("agent_start", () => {
    ledger.observeAgentStart();
  });

  pi.on("turn_start", (event) => {
    ledger.observeTurnStart(event.turnIndex);
  });

  pi.on("context", (event, ctx) => {
    const key = ledger.getDigestKey();
    const systemPrompt = ctx.getSystemPrompt();
    const matchesCurrent =
      typeof key === "string" &&
      typeof systemPromptDigest === "string" &&
      keyedDigest(systemPrompt, key) === systemPromptDigest;
    const sources = attributeContext({
      system: {
        systemPrompt,
        options: { cwd: ctx.cwd },
        matchesCurrent,
      },
      precomputedSystemRows: matchesCurrent ? systemRows : undefined,
      messages: event.messages,
      promptSource,
      currentPromptDigest,
      digestKey: key,
      skillReads,
      activeTools: pi.getActiveTools(),
      allTools: pi.getAllTools(),
      cwd: ctx.cwd,
    });
    ledger.observeContext(sources);
  });

  pi.on("before_provider_request", (_event, ctx) => {
    const model = ctx.model;
    const provider = typeof model?.provider === "string" ? model.provider : "unavailable";
    const api = typeof model?.api === "string" ? model.api : "unavailable";
    const modelId = typeof model?.id === "string" ? model.id : "unavailable";
    ledger.observeProviderRequest({
      provider,
      api,
      model: modelId,
      measurement: provider !== "unavailable" && api !== "unavailable" && modelId !== "unavailable" ? "recorded" : "unavailable",
    });
  });

  pi.on("message_end", (event) => {
    ledger.observeMessageEnd(event.message);
  });

  pi.on("tool_call", (event) => {
    if (event.toolName !== "read") return;
    const input = event.input as { path?: unknown };
    const readPath = input?.path;
    if (typeof readPath !== "string" || readPath.length === 0) return;
    const key = ledger.getDigestKey();
    const label = matchSkillPathDigest(readPath, key, skillPathDigests);
    if (typeof label === "string" && label.length > 0) {
      skillReads.set(event.toolCallId, label);
    }
  });

  pi.on("agent_settled", () => {
    clearCapture();
    ledger.observeAgentSettled();
  });

  pi.on("session_before_compact", () => {
    ledger.observeBeforeCompact();
  });

  pi.on("session_compact", () => {
    ledger.observeCompact();
  });

  pi.on("session_before_tree", () => {
    ledger.observeBeforeTree();
  });

  pi.on("session_tree", () => {
    clearCapture();
    ledger.observeTree();
  });

  pi.on("session_before_switch", () => {
    clearCapture();
    ledger.observeBeforeSwitch();
  });

  pi.on("session_before_fork", () => {
    clearCapture();
    ledger.observeBeforeFork();
  });

  pi.on("session_shutdown", () => {
    clearCapture();
    ledger.observeShutdown();
  });

  pi.registerCommand("context_attribution", {
    description: "Show estimated context sources for the latest foreground request",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /context_attribution", "warning");
        return;
      }
      await showContextAttribution(ledger.snapshot(), ctx);
    },
  });
}
