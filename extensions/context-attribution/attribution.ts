import { createHmac } from "node:crypto";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import type { BuildSystemPromptOptions, Skill, SlashCommandInfo, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  MAX_LABEL_LENGTH,
  countJsonCharacters,
  estimateImageCharacters,
  estimateTokens,
  estimatedValue,
  recordedValue,
  sanitizeLabel,
  sanitizePathLabel,
  sanitizeUrlLabel,
  unavailableValue,
} from "./estimate.ts";
import type { Attribution, SourceCategory, SourceEstimate, WarningCode } from "./types.ts";

/**
 * Pure source-attribution layer for one foreground request.
 *
 * Every raw runtime value stays inside the function call that received it.
 * The returned rows contain numeric metrics, fixed labels, and sanitized
 * labels only.
 */

export type PromptSource =
  | { readonly kind: "plain" }
  | { readonly kind: "skill"; readonly name: string }
  | { readonly kind: "prompt"; readonly name: string };

/**
 * One portable dependency boundary to Pi's public skill formatter.
 *
 * Pi provides @earendil-works/pi-coding-agent to extensions at runtime
 * through the extension-loader aliases, so the catalog span claim always
 * matches the system prompt that the running Pi builds. The pinned test
 * dependency in package.json resolves the same public export for the
 * standalone focused tests.
 */
export { formatSkillsForPrompt };

/**
 * Keyed HMAC-SHA256 hex digest for runtime boundary matching.
 * The same key backs the current-prompt and skill-path boundaries.
 */
export function keyedDigest(value: string, key: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

/**
 * Matches a transient read path against keyed skill-path digests.
 * The caller captures a keyed digest of each Skill.filePath at
 * before_agent_start and matches read paths at the tool_call boundary.
 */
export function matchSkillPathDigest(
  readPath: unknown,
  key: string | undefined,
  skillPathDigests: ReadonlyMap<string, string> | undefined,
): string | undefined {
  if (typeof readPath !== "string" || readPath.length === 0 || typeof key !== "string" || key.length === 0 || !skillPathDigests) {
    return undefined;
  }
  return skillPathDigests.get(keyedDigest(readPath, key));
}

export interface SystemAttributionInput {
  /** The effective system prompt at the context event. */
  readonly systemPrompt: string;
  /** Structured options captured at before_agent_start. */
  readonly options: BuildSystemPromptOptions;
  /** False when the recorded system digest no longer matches the current prompt. */
  readonly matchesCurrent: boolean;
}

export interface AttributionInput {
  readonly system: SystemAttributionInput;
  /** Used only during this call. Never cloned or retained. */
  readonly messages: readonly AgentMessage[];
  readonly promptSource?: PromptSource;
  /** Keyed HMAC-SHA256 hex digest of the expanded current prompt text. */
  readonly currentPromptDigest?: string;
  /** HMAC key that produced the current-prompt digest. */
  readonly digestKey?: string;
  /** Maps a tool-call ID to a safe skill label. */
  readonly skillReads?: ReadonlyMap<string, string>;
  readonly activeTools: readonly string[];
  readonly allTools: readonly ToolInfo[];
  /** Working directory for sanitized tool labels. */
  readonly cwd?: string;
}

type AnyMessage = { role?: unknown; [key: string]: unknown };

const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

/** Caps the complete final label or key at the approved limit. */
function limitLabel(value: string): string {
  return value.length <= MAX_LABEL_LENGTH ? value : value.slice(0, MAX_LABEL_LENGTH - 1) + "…";
}

/** True when the value looks like a URL scheme instead of a Windows drive. */
function looksLikeUrl(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !/^[A-Za-z]:[\\/]/.test(value);
}

/**
 * Facade-level dynamic label sanitizer.
 *
 * Removes control characters before URL and path detection. This prevents a
 * control-bearing URL from bypassing sanitization and leaking credentials,
 * queries, or fragments into a returned label or key.
 */
function safeDynamicLabel(value: unknown): string {
  if (typeof value !== "string") return "unavailable";
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, "").trim();
  if (!cleaned) return "unavailable";
  if (looksLikeUrl(cleaned)) return sanitizeUrlLabel(cleaned);
  return sanitizeLabel(cleaned);
}

/** One public facade that returns stable sanitized source rows. */
export function attributeContext(input: AttributionInput): SourceEstimate[] {
  return mergeSanitizedRows([
    ...attributeSystem(input.system),
    ...attributeMessages(input.messages, input.promptSource, input.skillReads, input.currentPromptDigest, input.digestKey),
    ...attributeTools(input.activeTools, input.allTools, input.cwd),
  ]);
}

/**
 * Classify the current prompt from its first slash-command token.
 * The body text is never inspected for extension markers.
 */
export function classifyPromptSource(inputText: string, commands: readonly SlashCommandInfo[]): PromptSource {
  const text = typeof inputText === "string" ? inputText : "";
  const firstToken = text.trimStart().split(/\s+/, 1)[0] ?? "";
  if (!firstToken.startsWith("/")) return { kind: "plain" };
  const raw = firstToken.slice(1);
  const command = Array.isArray(commands) ? commands.find((c) => c?.name === raw) : undefined;
  if (command) {
    if (command.source === "skill") {
      const name = raw.startsWith("skill:") ? raw.slice("skill:".length) : raw;
      return { kind: "skill", name: safeDynamicLabel(name) };
    }
    if (command.source === "prompt") return { kind: "prompt", name: safeDynamicLabel(raw) };
  }
  return { kind: "plain" };
}

// ---------------------------------------------------------------------------
// System prompt span claiming
// ---------------------------------------------------------------------------

/** Claims each character span at most once. */
class SpanClaimant {
  private readonly text: string;
  private readonly claimed: Uint8Array;

  constructor(text: string) {
    this.text = typeof text === "string" ? text : "";
    this.claimed = new Uint8Array(this.text.length);
  }

  claim(needle: string): number {
    if (needle.length === 0 || needle.length > this.text.length) return 0;
    let from = 0;
    while (from <= this.text.length - needle.length) {
      const index = this.text.indexOf(needle, from);
      if (index === -1) return 0;
      if (this.isFree(index, index + needle.length)) {
        this.mark(index, index + needle.length);
        return needle.length;
      }
      from = index + 1;
    }
    return 0;
  }
  unclaimed(): number {
    let total = 0;
    for (const mark of this.claimed) {
      if (mark === 0) total += 1;
    }
    return total;
  }

  private isFree(start: number, end: number): boolean {
    for (let i = start; i < end; i += 1) {
      if (this.claimed[i] !== 0) return false;
    }
    return true;
  }

  private mark(start: number, end: number): void {
    for (let i = start; i < end; i += 1) this.claimed[i] = 1;
  }
}

function attributeSystem(input: SystemAttributionInput): SourceEstimate[] {
  const systemPrompt = typeof input.systemPrompt === "string" ? input.systemPrompt : "";
  const options = (input.options ?? {}) as BuildSystemPromptOptions;
  if (!input.matchesCurrent) {
    return [finalSystemRow(systemPrompt)];
  }
  const claimant = new SpanClaimant(systemPrompt);
  const rows: SourceEstimate[] = [];

  const customPrompt = typeof options.customPrompt === "string" ? options.customPrompt : "";
  const hasCustom = customPrompt.length > 0;
  if (hasCustom) {
    rows.push(systemRow("system:custom-prompt", "system", "Custom system prompt", "attributed", claimant.claim(customPrompt), 1));
  }

  const contextFiles = Array.isArray(options.contextFiles) ? options.contextFiles : [];
  contextFiles.forEach((file, index) => {
    if (!file) return;
    const content = typeof file.content === "string" ? file.content : "";
    const label = typeof file.path === "string" && file.path.length > 0 ? sanitizePathLabel(file.path, options.cwd) : "Instruction file";
    rows.push(systemRow(`system:instruction:${index}`, "instructions", label, "attributed", claimant.claim(content), 1));
  });

  const append = typeof options.appendSystemPrompt === "string" ? options.appendSystemPrompt : "";
  if (append.length > 0) {
    rows.push(systemRow("system:append", "system", "Append system prompt", "attributed", claimant.claim(append), 1));
  }

  const skills = Array.isArray(options.skills) ? options.skills : [];
  const selectedTools = Array.isArray(options.selectedTools) ? options.selectedTools : DEFAULT_TOOLS;
  if (selectedTools.includes("read") && skills.length > 0) {
    const catalog = formatSkillsForPrompt(skills as Skill[]);
    const visibleCount = skills.filter((skill) => skill?.disableModelInvocation !== true).length;
    rows.push(systemRow("system:skill-catalog", "skills", "Skill catalog", "attributed", claimant.claim(catalog), visibleCount));
  }

  if (!hasCustom) {
    // Pi shows a snippet only for a selected tool.
    const snippets = options.toolSnippets;
    if (snippets && typeof snippets === "object") {
      const tools = Array.isArray(options.selectedTools) ? options.selectedTools : DEFAULT_TOOLS;
      let chars = 0;
      let count = 0;
      for (const name of tools) {
        if (typeof name !== "string") continue;
        const snippet = (snippets as Record<string, unknown>)[name];
        if (typeof snippet === "string" && snippet.length > 0) {
          chars += claimant.claim(snippet);
          count += 1;
        }
      }
      if (count > 0) {
        rows.push(systemRow("system:tool-snippets", "system", "Tool prompt snippets", "attributed", chars, count));
      }
    }
    // Pi trims, drops empty, and deduplicates guidelines with one shared set
    // (dist/core/system-prompt.js:44-72). Pi inserts the conditional Bash
    // guideline before promptGuidelines and the two always-included
    // guidelines afterward. Seed only the earlier conditional guideline so a
    // supplied duplicate cannot claim a core-owned span, and process the
    // supplied values before the later core defaults. The always-included
    // core defaults themselves stay in the unattributed remainder.
    const guidelines = Array.isArray(options.promptGuidelines) ? options.promptGuidelines : [];
    const seen = new Set<string>();
    const toolNames = Array.isArray(options.selectedTools) ? options.selectedTools : DEFAULT_TOOLS;
    if (toolNames.includes("bash") && !toolNames.includes("grep") && !toolNames.includes("find") && !toolNames.includes("ls")) {
      seen.add("Use bash for file operations like ls, rg, find");
    }
    let chars = 0;
    let count = 0;
    for (const guideline of guidelines) {
      if (typeof guideline !== "string") continue;
      const normalized = guideline.trim();
      if (normalized.length === 0 || seen.has(normalized)) continue;
      seen.add(normalized);
      chars += claimant.claim(normalized);
      count += 1;
    }
    if (count > 0) {
      rows.push(systemRow("system:guidelines", "system", "Prompt guidelines", "attributed", chars, count));
    }
  }

  const cwd = typeof options.cwd === "string" ? options.cwd.replace(/\\/g, "/") : "";
  if (cwd.length > 0) {
    rows.push(systemRow("system:cwd", "system", sanitizePathLabel(cwd, options.cwd), "attributed", claimant.claim(cwd), 1));
  }

  const remainder = claimant.unclaimed();
  if (remainder > 0) {
    rows.push(systemRow("system:remainder", "system", "Pi core, wrappers, or extension changes", "unattributed", remainder, 1));
  }
  return rows;
}

function finalSystemRow(systemPrompt: string): SourceEstimate {
  const chars = systemPrompt.length;
  return {
    key: "system:final",
    category: "system",
    label: "Final system prompt",
    attribution: "unattributed",
    characters: estimatedValue(chars),
    tokens: estimatedValue(estimateTokens(chars)),
    itemCount: recordedValue(1),
    warning: "system-digest-mismatch",
  };
}

function systemRow(key: string, category: SourceCategory, label: string, attribution: Attribution, chars: number, items: number): SourceEstimate {
  return {
    key,
    category,
    label,
    attribution,
    characters: recordedValue(chars),
    tokens: estimatedValue(estimateTokens(chars)),
    itemCount: recordedValue(items),
  };
}

// ---------------------------------------------------------------------------
// Message traversal
// ---------------------------------------------------------------------------

interface AccumulatedRow {
  readonly key: string;
  readonly category: SourceCategory;
  readonly label: string;
  readonly attribution: Attribution;
  chars: number;
  count: number;
  failed: boolean;
  warning?: WarningCode;
}

interface MessageAccumulator {
  readonly rows: Map<string, AccumulatedRow>;
  images: number;
}

function createAccumulator(): MessageAccumulator {
  return { rows: new Map(), images: 0 };
}

function addRow(
  acc: MessageAccumulator,
  key: string,
  category: SourceCategory,
  label: string,
  attribution: Attribution,
  chars: number,
  count: number,
  warning?: WarningCode,
  failed = false,
): void {
  const existing = acc.rows.get(key);
  if (existing) {
    existing.chars += chars;
    existing.count += count;
    if (failed) existing.failed = true;
    if (warning !== undefined && existing.warning === undefined) existing.warning = warning;
    return;
  }
  acc.rows.set(key, { key, category, label, attribution, chars, count, failed, warning });
}

function accumulatorRows(acc: MessageAccumulator): SourceEstimate[] {
  const rows: SourceEstimate[] = [];
  for (const row of acc.rows.values()) {
    rows.push({
      key: row.key,
      category: row.category,
      label: row.label,
      attribution: row.attribution,
      characters: row.failed ? unavailableValue() : recordedValue(row.chars),
      tokens: row.failed ? unavailableValue() : estimatedValue(estimateTokens(row.chars)),
      itemCount: recordedValue(row.count),
      warning: row.warning,
    });
  }
  if (acc.images > 0) {
    const chars = estimateImageCharacters(acc.images);
    rows.push({
      key: "msg:images",
      category: "images",
      label: "Images",
      attribution: "attributed",
      characters: estimatedValue(chars),
      tokens: estimatedValue(estimateTokens(chars)),
      itemCount: recordedValue(acc.images),
    });
  }
  return rows;
}

function attributeMessages(
  messages: readonly AgentMessage[],
  promptSource: PromptSource | undefined,
  skillReads: ReadonlyMap<string, string> | undefined,
  currentPromptDigest: string | undefined,
  digestKey: string | undefined,
): SourceEstimate[] {
  const acc = createAccumulator();
  const currentPromptIndex = findCurrentPromptIndex(messages, currentPromptDigest, digestKey);
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i] as AnyMessage;
    const role = message.role;
    switch (role) {
      case "user":
        visitUser(message, i === currentPromptIndex, currentPromptIndex >= 0 && i > currentPromptIndex, promptSource, acc);
        break;
      case "assistant":
        visitAssistant(message, acc);
        break;
      case "toolResult":
        visitToolResult(message, skillReads, acc);
        break;
      case "custom":
        visitCustom(message, acc);
        break;
      case "bashExecution":
        visitBash(message, acc);
        break;
      case "branchSummary": {
        const summary = typeof message.summary === "string" ? message.summary : "";
        addRow(acc, "msg:branch-summary", "summary", "Branch summary", "attributed", summary.length, 1);
        break;
      }
      case "compactionSummary": {
        const summary = typeof message.summary === "string" ? message.summary : "";
        addRow(acc, "msg:compaction-summary", "summary", "Compaction summary", "unattributed", summary.length, 1);
        break;
      }
      default:
        visitUnknown(message, acc);
        break;
    }
  }
  return accumulatorRows(acc);
}

/**
 * Joins the text blocks of a user message without returning raw values.
 */
function userTextContent(message: AnyMessage): string | null {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  let text = "";
  for (const block of content) {
    if (block && typeof block === "object") {
      const value = block as Record<string, unknown>;
      if (value.type === "text" && typeof value.text === "string") text += value.text;
    }
  }
  return text;
}

/**
 * Finds the evidence-based current-prompt boundary.
 *
 * With a keyed prompt digest, the current prompt is the most recent user
 * message whose text hashes to that digest. Pi captures this digest from
 * before_agent_start.prompt. The digest preserves the boundary through
 * tool-loop requests, where Pi appends assistant responses and tool results
 * without a new user message. A digest with no matching message fails closed:
 * no message is claimed as the current prompt.
 *
 * Without a digest, Pi appends the expanded current prompt as the first
 * message of the new turn, then injects batch custom messages and later
 * steering messages. The current prompt is therefore the first user-role
 * message after the last message that is neither user-role nor custom-role.
 * User-role messages after that boundary are generic extension text without
 * source metadata.
 */
function findCurrentPromptIndex(messages: readonly AgentMessage[], currentPromptDigest: string | undefined, digestKey: string | undefined): number {
  if (typeof currentPromptDigest === "string" && currentPromptDigest.length > 0 && typeof digestKey === "string" && digestKey.length > 0) {
    // A repeated prompt can hash to the same digest as an older historical
    // prompt. Search from the end so the digest resolves to the current
    // match, and older identical prompts stay plain user history.
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const text = userTextContent(messages[i] as AnyMessage);
      if (text !== null && keyedDigest(text, digestKey) === currentPromptDigest) return i;
    }
    return -1;
  }
  let boundary = -1;
  for (let i = 0; i < messages.length; i += 1) {
    const role = (messages[i] as AnyMessage)?.role;
    if (role !== "user" && role !== "custom") boundary = i;
  }
  for (let i = boundary + 1; i < messages.length; i += 1) {
    if ((messages[i] as AnyMessage)?.role === "user") return i;
  }
  return -1;
}

function visitUser(message: AnyMessage, isCurrent: boolean, isAfterCurrent: boolean, promptSource: PromptSource | undefined, acc: MessageAccumulator): void {
  const chars = contentLength(message.content, acc);
  if (isCurrent && promptSource?.kind === "skill") {
    addRow(acc, "msg:skill-prompt", "skills", limitLabel(`Skill: ${safeDynamicLabel(promptSource.name)}`), "attributed", chars, 1);
  } else if (isCurrent && promptSource?.kind === "prompt") {
    addRow(acc, "msg:prompt-template", "prompts", limitLabel(`Prompt template: ${safeDynamicLabel(promptSource.name)}`), "attributed", chars, 1);
  } else if (isAfterCurrent) {
    addRow(acc, "msg:user-unattributed", "conversation", "User text without source metadata", "unattributed", chars, 1);
  } else {
    addRow(acc, "msg:user", "conversation", "User history", "attributed", chars, 1);
  }
}

function visitAssistant(message: AnyMessage, acc: MessageAccumulator): void {
  const content = Array.isArray(message.content) ? message.content : [];
  let textChars = 0;
  let thinkingChars = 0;
  let thinkingBlocks = 0;
  let callChars = 0;
  let calls = 0;
  let failed = false;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const value = block as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") {
      textChars += value.text.length;
    } else if (value.type === "thinking" && typeof value.thinking === "string") {
      thinkingChars += value.thinking.length;
      thinkingBlocks += 1;
    } else if (value.type === "toolCall") {
      calls += 1;
      const count = countJsonCharacters(value.arguments);
      if (count === null) failed = true;
      else callChars += count;
    }
  }
  if (textChars > 0) addRow(acc, "msg:assistant", "assistant", "Assistant history", "attributed", textChars, 1);
  if (thinkingBlocks > 0) addRow(acc, "msg:thinking", "thinking", "Assistant thinking", "attributed", thinkingChars, thinkingBlocks);
  if (calls > 0) addRow(acc, "msg:tool-call", "tool-call", "Tool calls", "attributed", callChars, calls, failed ? "serialization-unavailable" : undefined, failed);
}

function visitToolResult(message: AnyMessage, skillReads: ReadonlyMap<string, string> | undefined, acc: MessageAccumulator): void {
  const chars = contentLength(message.content, acc);
  const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
  const matchedSkill = toolCallId.length > 0 ? skillReads?.get(toolCallId) : undefined;
  if (matchedSkill) {
    const name = safeDynamicLabel(matchedSkill);
    addRow(acc, limitLabel(`msg:skill-read:${name}`), "skills", limitLabel(`Skill body: ${name}`), "attributed", chars, 1);
  } else {
    addRow(acc, "msg:tool-result", "tool-result", "Tool results", "attributed", chars, 1);
  }
}

function visitCustom(message: AnyMessage, acc: MessageAccumulator): void {
  const customType = typeof message.customType === "string" ? message.customType : "";
  const chars = contentLength(message.content, acc);
  if (customType === "pi-memory-context") {
    addRow(acc, "msg:memory:pi-memory-context", "memory", "Memory context", "attributed", chars, 1);
  } else if (customType === "pi-session-search-primer") {
    addRow(acc, "msg:memory:pi-session-search-primer", "memory", "Session search primer", "attributed", chars, 1);
  } else if (customType === "knowledge-overview") {
    addRow(acc, "msg:memory:knowledge-overview", "memory", "Knowledge overview", "attributed", chars, 1);
  } else if (customType === "context-prune-summary") {
    addRow(acc, "msg:prune-summary", "summary", "Context-prune summary", "unattributed", chars, 1);
  } else {
    const safe = safeDynamicLabel(customType.length > 0 ? customType : "unavailable");
    addRow(acc, limitLabel(`msg:custom:${safe}`), "custom", limitLabel(`Extension: ${safe}`), "attributed", chars, 1);
  }
}

function visitBash(message: AnyMessage, acc: MessageAccumulator): void {
  if (message.excludeFromContext === true) return;
  const command = typeof message.command === "string" ? message.command : "";
  const output = typeof message.output === "string" ? message.output : "";
  addRow(acc, "msg:bash", "tool-result", "Bash execution", "attributed", command.length + output.length, 1);
}

function visitUnknown(message: unknown, acc: MessageAccumulator): void {
  const count = countJsonCharacters(message);
  addRow(acc, "msg:unknown", "unattributed", "Unknown message", "unattributed", count ?? 0, 1, count === null ? "serialization-unavailable" : undefined, count === null);
}

/** Counts text characters and image blocks without returning either value. */
function contentLength(content: unknown, acc: MessageAccumulator): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const value = block as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") chars += value.text.length;
    else if (value.type === "image") acc.images += 1;
  }
  return chars;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOL_SCOPE_VALUES = new Set(["user", "project", "temporary"]);
const TOOL_ORIGIN_VALUES = new Set(["package", "top-level"]);

function attributeTools(activeTools: readonly string[], allTools: readonly ToolInfo[], cwd: string | undefined): SourceEstimate[] {
  const byName = new Map<string, ToolInfo>();
  for (const tool of allTools ?? []) {
    if (tool && typeof tool.name === "string") byName.set(tool.name, tool);
  }
  const groups = new Map<string, { label: string; chars: number; count: number; failed: boolean }>();
  for (const name of activeTools ?? []) {
    const tool = byName.get(name);
    if (!tool) continue;
    const provenance = toolProvenance(tool.sourceInfo, cwd);
    const chars = countJsonCharacters({ name: tool.name, description: tool.description, parameters: tool.parameters });
    let group = groups.get(provenance.key);
    if (!group) {
      group = { label: provenance.label, chars: 0, count: 0, failed: false };
      groups.set(provenance.key, group);
    }
    group.count += 1;
    if (chars === null) group.failed = true;
    else group.chars += chars;
  }
  const rows: SourceEstimate[] = [];
  for (const [key, group] of groups) {
    rows.push({
      key,
      category: "tools",
      label: group.label,
      attribution: "attributed",
      characters: group.failed ? unavailableValue() : recordedValue(group.chars),
      tokens: group.failed ? unavailableValue() : estimatedValue(estimateTokens(group.chars)),
      itemCount: recordedValue(group.count),
      warning: group.failed ? "serialization-unavailable" : undefined,
    });
  }
  return rows;
}

/** Builds a safe provenance key and label from scope, origin, and source. */
function toolProvenance(sourceInfo: ToolInfo["sourceInfo"] | undefined, cwd: string | undefined): { key: string; label: string } {
  if (!sourceInfo) return { key: "tools:pi built-in", label: "Tools: pi built-in" };
  if (sourceInfo.source === "builtin") return { key: "tools:pi built-in", label: "Tools: pi built-in" };
  if (sourceInfo.source === "sdk") return { key: "tools:pi sdk", label: "Tools: pi sdk" };
  const scope = typeof sourceInfo.scope === "string" && TOOL_SCOPE_VALUES.has(sourceInfo.scope) ? sourceInfo.scope : "unknown";
  const origin = typeof sourceInfo.origin === "string" && TOOL_ORIGIN_VALUES.has(sourceInfo.origin) ? sourceInfo.origin : "unknown";
  const source = toolSourceLabel(sourceInfo, cwd);
  const key = limitLabel(`tools:${scope}:${origin}:${source}`);
  const label = limitLabel(`Tools: ${scope}/${origin}/${source}`);
  return { key, label };
}

function toolSourceLabel(sourceInfo: ToolInfo["sourceInfo"] | undefined, cwd: string | undefined): string {
  if (!sourceInfo) return "pi built-in";
  if (sourceInfo.source === "builtin") return "pi built-in";
  if (sourceInfo.source === "sdk") return "pi sdk";
  const raw =
    typeof sourceInfo.path === "string" && sourceInfo.path.length > 0
      ? sourceInfo.path
      : typeof sourceInfo.source === "string"
        ? sourceInfo.source
        : "";
  if (!raw) return "unavailable";
  const match = /^<([^:>]+):([^>]+)>/.exec(raw);
  if (match) {
    // Sanitize the wrapped value before any fixed prefix so URL and path
    // detection can still see credentials, queries, and fragments.
    const scheme = safeDynamicLabel(match[1]);
    const value = safeDynamicLabel(match[2]);
    if (scheme === "unavailable" || value === "unavailable") return "unavailable";
    return limitLabel(`${scheme}/${value}`);
  }
  const cleaned = raw.replace(/[\u0000-\u001f\u007f-\u009f]+/g, "").trim();
  if (looksLikeUrl(cleaned)) return limitLabel(sanitizeUrlLabel(cleaned));
  return limitLabel(sanitizePathLabel(raw, cwd ?? process.cwd()));
}

// ---------------------------------------------------------------------------
// Row merging
// ---------------------------------------------------------------------------

function mergeSanitizedRows(rows: readonly SourceEstimate[]): SourceEstimate[] {
  const merged = new Map<string, SourceEstimate>();
  for (const row of rows) {
    const existing = merged.get(row.key);
    if (!existing) {
      merged.set(row.key, row);
      continue;
    }
    merged.set(row.key, mergeRow(existing, row));
  }
  return [...merged.values()];
}

function mergeRow(a: SourceEstimate, b: SourceEstimate): SourceEstimate {
  const charsA = a.characters.value;
  const charsB = b.characters.value;
  const bothNumeric = typeof charsA === "number" && typeof charsB === "number";
  const itemA = a.itemCount.value;
  const itemB = b.itemCount.value;
  return {
    key: a.key,
    category: a.category,
    label: a.label,
    attribution: a.attribution,
    characters: bothNumeric ? recordedValue(charsA + charsB) : unavailableValue(),
    tokens: bothNumeric ? estimatedValue(estimateTokens(charsA + charsB)) : unavailableValue(),
    itemCount: typeof itemA === "number" && typeof itemB === "number" ? recordedValue(itemA + itemB) : unavailableValue(),
    warning: a.warning ?? b.warning,
  };
}
