import assert from "node:assert/strict";
import { test } from "node:test";
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext, Skill, SlashCommandInfo, ToolInfo } from "@earendil-works/pi-coding-agent";
import contextAttributionExtension from "./index.ts";

/**
 * Integration tests for the standalone /context_attribution entry point.
 *
 * The tests drive the registered hook handlers with synthetic events and
 * inspect the command output. They never touch the private ledger directly.
 * Every fixture value is synthetic.
 */

const SYSTEM_PROMPT = "Synthetic Pi system prompt for the focused test.";
const SYSTEM_OPTIONS: BuildSystemPromptOptions = {
  cwd: "/tmp",
  contextFiles: [{ path: "/tmp/AGENTS.md", content: "Synthetic AGENTS content." }],
  appendSystemPrompt: "Synthetic append.",
  skills: [],
};

/** A Model-shaped fixture. Real Pi Model objects carry id, api, and provider. */
const FAKE_MODEL: Record<string, unknown> = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  api: "openai-responses",
  provider: "openai-codex",
  baseUrl: "https://api.example.test/v1",
};

interface FakeExtension {
  handlers: Map<string, (event: Record<string, unknown>, ctx?: ExtensionContext) => unknown>;
  commands: Array<{ name: string; description: string; handler: (args: string, ctx: ExtensionContext) => unknown }>;
  calls: { appendEntry: number; sendMessage: number; sendUserMessage: number };
}

function createCtx(overrides: Record<string, unknown> = {}): ExtensionContext {
  const ui = {
    notify: () => {},
    custom: async () => undefined,
  };
  return {
    mode: "print",
    ui,
    cwd: "/tmp",
    getSystemPrompt: () => SYSTEM_PROMPT,
    model: FAKE_MODEL,
    ...overrides,
  } as unknown as ExtensionContext;
}

const FAKE_CTX = createCtx();

/** Formatting contract mirrors: "  " + label.padEnd(14) + " " + value.padStart(11). */
function usageLine(label: string, value: string): string {
  return `  ${label.padEnd(14)} ${value.padStart(11)}`;
}

function createExtension(options: { commands?: SlashCommandInfo[]; tools?: ToolInfo[]; activeTools?: string[] } = {}): FakeExtension {
  const handlers = new Map<string, (event: Record<string, unknown>, ctx?: ExtensionContext) => unknown>();
  const commands: FakeExtension["commands"] = [];
  const calls = { appendEntry: 0, sendMessage: 0, sendUserMessage: 0 };
  const pi = {
    on(event: string, handler: (event: Record<string, unknown>, ctx?: ExtensionContext) => unknown) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, commandOptions: Omit<FakeExtension["commands"][number], "name">) {
      commands.push({ name, ...commandOptions });
    },
    getCommands: () => options.commands ?? [],
    getActiveTools: () => options.activeTools ?? [],
    getAllTools: () => options.tools ?? [],
    appendEntry: () => {
      calls.appendEntry += 1;
    },
    sendMessage: () => {
      calls.sendMessage += 1;
    },
    sendUserMessage: () => {
      calls.sendUserMessage += 1;
    },
  };
  contextAttributionExtension(pi as unknown as ExtensionAPI);
  return { handlers, commands, calls };
}

function emit(ext: FakeExtension, event: Record<string, unknown>, ctx: ExtensionContext = FAKE_CTX): unknown {
  const handler = ext.handlers.get(String(event.type));
  assert.ok(handler, `no handler for event ${String(event.type)}`);
  return handler(event, ctx);
}

function assistantMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    usage: { input: 100, output: 40, cacheRead: 500, cacheWrite: 0, totalTokens: 640 },
    stopReason: "stop",
    content: [{ type: "text", text: "Synthetic assistant text." }],
    timestamp: 1,
    ...overrides,
  };
}

interface SequenceOptions {
  promptText?: string;
  expandedPrompt?: string;
  source?: string;
  systemPrompt?: string;
  systemOptions?: BuildSystemPromptOptions;
  toolLoop?: boolean;
  skillRead?: { toolCallId: string; path: string };
  ctx?: ExtensionContext;
}

/** One complete foreground run through the registered hooks. */
function runForeground(ext: FakeExtension, options: SequenceOptions = {}): void {
  const prompt = options.expandedPrompt ?? options.promptText ?? "SAFE_PROMPT_ONLY";
  const systemPrompt = options.systemPrompt ?? SYSTEM_PROMPT;
  const systemOptions = options.systemOptions ?? SYSTEM_OPTIONS;
  const ctx = options.ctx ?? FAKE_CTX;
  emit(ext, { type: "session_start", reason: "startup" });
  emit(ext, { type: "input", text: options.promptText ?? prompt, source: options.source ?? "interactive" });
  emit(ext, { type: "before_agent_start", prompt, systemPrompt, systemPromptOptions: systemOptions });
  emit(ext, { type: "agent_start" });
  const messages: Record<string, unknown>[] = [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: 1 }];
  emit(ext, { type: "context", messages }, ctx);
  emit(ext, { type: "before_provider_request", payload: { safe: "payload" } }, ctx);
  emit(ext, { type: "message_end", message: assistantMessage() });
  if (options.toolLoop) {
    messages.push(assistantMessage({ stopReason: "toolUse" }));
    if (options.skillRead) {
      emit(ext, {
        type: "tool_call",
        toolCallId: options.skillRead.toolCallId,
        toolName: "read",
        input: { path: options.skillRead.path },
      });
    }
    messages.push({ role: "toolResult", toolCallId: options.skillRead?.toolCallId ?? "call-1", content: [{ type: "text", text: "Synthetic tool result." }], timestamp: 2 });
    emit(ext, { type: "context", messages }, ctx);
    emit(ext, { type: "before_provider_request", payload: { safe: "payload" } }, ctx);
    emit(ext, { type: "message_end", message: assistantMessage() });
  }
  emit(ext, { type: "agent_settled" });
}

async function captureLog<T>(fn: () => T | Promise<T>): Promise<{ log: string[]; value: T }> {
  const log: string[] = [];
  const original = console.log;
  console.log = (message?: unknown) => {
    log.push(String(message));
  };
  try {
    return { log, value: await fn() };
  } finally {
    console.log = original;
  }
}

async function invokeCommand(ext: FakeExtension, args = "", ctx: ExtensionContext = FAKE_CTX): Promise<unknown> {
  const command = ext.commands.find((c) => c.name === "context_attribution");
  assert.ok(command, "context_attribution command missing");
  return command.handler(args, ctx);
}

const REQUIRED_HOOKS = [
  "session_start",
  "input",
  "before_agent_start",
  "agent_start",
  "turn_start",
  "context",
  "before_provider_request",
  "message_end",
  "tool_call",
  "agent_settled",
  "session_before_compact",
  "session_compact",
  "session_before_tree",
  "session_tree",
  "session_before_switch",
  "session_before_fork",
  "session_shutdown",
] as const;

test("registers exactly the context_attribution command", () => {
  const ext = createExtension();
  assert.deepEqual(
    ext.commands.map((c) => c.name),
    ["context_attribution"],
  );
  assert.equal(ext.commands[0]?.description, "Show estimated context sources for the latest foreground request");
  assert.equal(ext.commands[0]?.handler.length, 2);
});

test("registers every approved hook and no content-capture hook", () => {
  const ext = createExtension();
  const registered = [...ext.handlers.keys()];
  for (const hook of REQUIRED_HOOKS) {
    assert.ok(registered.includes(hook), `missing required hook ${hook}`);
  }
  assert.ok(!registered.includes("after_provider_response"), "after_provider_response must not be registered");
  assert.ok(!registered.includes("tool_result"), "tool_result must not be registered");
  assert.equal(registered.length, REQUIRED_HOOKS.length, "no extra hooks allowed");
});

test("a complete foreground request produces one recorded report", async () => {
  const ext = createExtension();
  runForeground(ext);
  const { log } = await captureLog(() => invokeCommand(ext));
  const text = log.join("\n");
  assert.equal(log.length, 1);
  assert.ok(text.includes("Context attribution — latest foreground request #1"));
  assert.ok(text.includes("Scope: foreground normal request [recorded]"));
  assert.ok(text.includes("Provider usage [provider-reported]"));
  assert.ok(text.includes(usageLine("input", "100")), text);
  assert.ok(text.includes(usageLine("total", "640")), text);
  assert.ok(text.includes("User history"));
  assert.ok(text.includes("Pi core, wrappers, or extension changes"));
  assert.ok(text.includes("  Eligible requests: 1"));
  assert.ok(text.includes("  Complete provider usage: 1"));
  assert.ok(text.includes("Model: openai-codex / openai-responses / gpt-5.6-sol [recorded]"), text);
  assert.ok(!text.includes("Provider attempts:"));
});

test("a two-request tool loop produces one record per request", async () => {
  const ext = createExtension();
  runForeground(ext, { toolLoop: true });
  const { log } = await captureLog(() => invokeCommand(ext));
  const text = log.join("\n");
  assert.ok(text.includes("Context attribution — latest foreground request #2"));
  assert.ok(text.includes("Scope: foreground normal request [recorded]"));
  assert.ok(text.includes("  Eligible requests: 2"));
  assert.ok(text.includes("  Complete provider usage: 2"));
  assert.ok(text.includes("Tool results"));
  assert.ok(!text.includes("Context attribution — latest foreground request #1"));
});

test("idle extension input creates no request and excludes the provider call", async () => {
  const ext = createExtension();
  runForeground(ext, { source: "extension" });
  const { log } = await captureLog(() => invokeCommand(ext));
  const text = log.join("\n");
  assert.ok(text.includes("Context attribution — no recorded request"));
  assert.ok(text.includes("  Eligible requests: 0"));
  assert.ok(text.includes("  Excluded provider calls: 1"));
  assert.ok(text.includes("  Correlation failures: 0"));
});

test("a PI_SUBAGENT_* environment key disables capture", async () => {
  process.env.PI_SUBAGENT_TEST_CHILD = "worker";
  try {
    const ext = createExtension();
    runForeground(ext);
    const { log } = await captureLog(() => invokeCommand(ext));
    const text = log.join("\n");
    assert.ok(text.includes("Context attribution — no recorded request"));
    assert.ok(text.includes("  Eligible requests: 0"));
    assert.ok(text.includes("  Excluded provider calls: 1"));
  } finally {
    delete process.env.PI_SUBAGENT_TEST_CHILD;
  }
});

test("compaction suppresses its provider call and keeps the next request", async () => {
  const ext = createExtension();
  emit(ext, { type: "session_start", reason: "startup" });
  emit(ext, { type: "input", text: "hello", source: "interactive" });
  emit(ext, { type: "before_agent_start", prompt: "hello", systemPrompt: SYSTEM_PROMPT, systemPromptOptions: SYSTEM_OPTIONS });
  emit(ext, { type: "agent_start" });
  emit(ext, { type: "context", messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }] });
  emit(ext, { type: "session_before_compact" });
  emit(ext, { type: "before_provider_request", payload: {} });
  emit(ext, { type: "session_compact" });
  emit(ext, { type: "context", messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }] });
  emit(ext, { type: "before_provider_request", payload: {} });
  emit(ext, { type: "message_end", message: assistantMessage() });
  emit(ext, { type: "agent_settled" });
  const { log } = await captureLog(() => invokeCommand(ext));
  const text = log.join("\n");
  assert.ok(text.includes("Context attribution — latest foreground request #2"));
  assert.ok(text.includes("  Eligible requests: 2"));
  assert.ok(text.includes("  Complete provider usage: 1"));
  assert.ok(text.includes("  Excluded provider calls: 1"));
});

test("tree navigation resets the ledger", async () => {
  const ext = createExtension();
  emit(ext, { type: "session_start", reason: "startup" });
  emit(ext, { type: "input", text: "hello", source: "interactive" });
  emit(ext, { type: "before_agent_start", prompt: "hello", systemPrompt: SYSTEM_PROMPT, systemPromptOptions: SYSTEM_OPTIONS });
  emit(ext, { type: "agent_start" });
  emit(ext, { type: "context", messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }] });
  emit(ext, { type: "session_before_tree" });
  emit(ext, { type: "before_provider_request", payload: {} });
  emit(ext, { type: "session_tree" });
  emit(ext, { type: "agent_settled" });
  const { log } = await captureLog(() => invokeCommand(ext));
  const text = log.join("\n");
  assert.ok(text.includes("Context attribution — no recorded request"));
  assert.ok(text.includes("  Eligible requests: 0"));
  assert.ok(text.includes("  Excluded provider calls: 0"));
  assert.ok(text.includes("  Correlation failures: 0"));
});

test("a provider call without a context draft is excluded", async () => {
  const ext = createExtension();
  emit(ext, { type: "session_start", reason: "startup" });
  emit(ext, { type: "before_provider_request", payload: {} });
  const { log } = await captureLog(() => invokeCommand(ext));
  const text = log.join("\n");
  assert.ok(text.includes("Context attribution — no recorded request"));
  assert.ok(text.includes("  Eligible requests: 0"));
  assert.ok(text.includes("  Excluded provider calls: 1"));
});

test("the provider hook never touches the payload proxy", () => {
  const ext = createExtension();
  let payloadAccesses = 0;
  const payload = new Proxy(
    {},
    {
      get() {
        payloadAccesses += 1;
        throw new Error("payload get trap");
      },
      has() {
        payloadAccesses += 1;
        throw new Error("payload has trap");
      },
      ownKeys() {
        payloadAccesses += 1;
        throw new Error("payload ownKeys trap");
      },
      getOwnPropertyDescriptor() {
        payloadAccesses += 1;
        throw new Error("payload descriptor trap");
      },
    },
  );
  const result = emit(ext, { type: "before_provider_request", payload });
  assert.equal(result, undefined);
  assert.equal(payloadAccesses, 0, "the payload proxy was accessed");
});

test("hooks return undefined and never mutate their events", () => {
  const ext = createExtension();
  const events: Record<string, Record<string, unknown>> = {
    session_start: { type: "session_start", reason: "startup" },
    input: { type: "input", text: "hello", source: "interactive" },
    before_agent_start: { type: "before_agent_start", prompt: "hello", systemPrompt: SYSTEM_PROMPT, systemPromptOptions: SYSTEM_OPTIONS },
    agent_start: { type: "agent_start" },
    turn_start: { type: "turn_start", turnIndex: 0 },
    context: { type: "context", messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }] },
    before_provider_request: { type: "before_provider_request", payload: {} },
    message_end: { type: "message_end", message: assistantMessage() },
    tool_call: { type: "tool_call", toolCallId: "call-1", toolName: "read", input: { path: "/tmp/readme.md" } },
    agent_settled: { type: "agent_settled" },
    session_before_compact: { type: "session_before_compact" },
    session_compact: { type: "session_compact" },
    session_before_tree: { type: "session_before_tree" },
    session_tree: { type: "session_tree" },
    session_before_switch: { type: "session_before_switch" },
    session_before_fork: { type: "session_before_fork" },
    session_shutdown: { type: "session_shutdown" },
  };
  for (const event of Object.values(events)) {
    const snapshot = JSON.stringify(event);
    Object.freeze(event);
    const handler = ext.handlers.get(String(event.type));
    assert.ok(handler, `no handler for ${String(event.type)}`);
    const result = handler(event, FAKE_CTX);
    assert.equal(result, undefined, `${String(event.type)} must return undefined`);
    assert.equal(JSON.stringify(event), snapshot, `${String(event.type)} mutated its event`);
  }
});

test("the extension never calls appendEntry, sendMessage, or sendUserMessage", async () => {
  const ext = createExtension();
  runForeground(ext, { toolLoop: true });
  await captureLog(() => invokeCommand(ext));
  assert.deepEqual(ext.calls, { appendEntry: 0, sendMessage: 0, sendUserMessage: 0 });
});

test("command arguments fail with the fixed usage message", async () => {
  const ext = createExtension();
  const notifications: Array<[string, string]> = [];
  const ctx = createCtx({
    ui: {
      notify: (message: string, level: string) => notifications.push([message, level]),
      custom: async () => undefined,
    },
  });
  const { log } = await captureLog(() => invokeCommand(ext, "extra arguments", ctx));
  assert.equal(log.length, 0, "the usage error must not print a report");
  assert.deepEqual(notifications, [["Usage: /context_attribution", "warning"]]);
});

test("whitespace-only arguments still show the report", async () => {
  const ext = createExtension();
  runForeground(ext);
  const notifications: Array<[string, string]> = [];
  const ctx = createCtx({
    ui: {
      notify: (message: string, level: string) => notifications.push([message, level]),
      custom: async () => undefined,
    },
  });
  const { log } = await captureLog(() => invokeCommand(ext, "   ", ctx));
  assert.equal(log.length, 1);
  assert.deepEqual(notifications, []);
  assert.ok(log[0].includes("Context attribution — latest foreground request #1"));
});

test("the command prints plain text and opens an overlay only in TUI mode", async () => {
  const ext = createExtension();
  runForeground(ext);
  for (const mode of ["print", "rpc", "json"]) {
    const { log } = await captureLog(() => invokeCommand(ext, "", createCtx({ mode })));
    assert.equal(log.length, 1, mode);
    assert.ok(log[0].includes("Context attribution — latest foreground request #1"), mode);
  }
  let customCalls = 0;
  let capturedFactory: unknown;
  const tuiCtx = createCtx({
    mode: "tui",
    ui: {
      notify: () => {},
      custom: async (factory: unknown) => {
        customCalls += 1;
        capturedFactory = factory;
        return undefined;
      },
    },
  });
  const { log } = await captureLog(() => invokeCommand(ext, "", tuiCtx));
  assert.equal(log.length, 0, "TUI mode must not print");
  assert.equal(customCalls, 1, "TUI mode must open a custom overlay");
  const component = (capturedFactory as (tui: unknown, theme: unknown, keybindings: unknown, done: () => void) => { render(width: number): string[]; handleInput(data: string): void })(
    { terminal: { rows: 40 } },
    {},
    {},
    () => {},
  );
  const lines = component.render(80);
  assert.ok(Array.isArray(lines) && lines.length > 0);
  assert.ok(lines.join("\n").includes("Context attribution — latest foreground request #1"));
});

test("a read of a known skill path attributes the tool result to the skill", async () => {
  const skill: Skill = {
    name: "commit",
    description: "Creates polished commits.",
    filePath: "/tmp/skills/commit/SKILL.md",
    baseDir: "/tmp/skills/commit",
    sourceInfo: { path: "/tmp/skills/commit/SKILL.md", source: "top-level", scope: "project", origin: "top-level" },
    disableModelInvocation: false,
  };
  const ext = createExtension();
  runForeground(ext, {
    systemOptions: { ...SYSTEM_OPTIONS, skills: [skill] },
    toolLoop: true,
    skillRead: { toolCallId: "call-skill-1", path: "/tmp/skills/commit/SKILL.md" },
  });
  const { log } = await captureLog(() => invokeCommand(ext));
  const text = log.join("\n");
  assert.ok(text.includes("Skill body: commit"), text);
  assert.ok(text.includes("  Eligible requests: 2"));
});

test("a skill command classifies the current prompt", async () => {
  const skillCommand: SlashCommandInfo = {
    name: "skill:commit",
    source: "skill",
    sourceInfo: { path: "/tmp/skills/commit", source: "top-level", scope: "project", origin: "top-level" },
  };
  const ext = createExtension({ commands: [skillCommand] });
  runForeground(ext, { promptText: "/skill:commit fix the bug", expandedPrompt: "SKILL_BODY\n\nfix the bug" });
  const { log } = await captureLog(() => invokeCommand(ext));
  const text = log.join("\n");
  assert.ok(text.includes("Skill: commit"), text);
  assert.ok(!text.includes("User history"), "the skill prompt replaces the plain user row");
});

test("a prompt template command classifies the current prompt", async () => {
  const templateCommand: SlashCommandInfo = {
    name: "interactive-plan",
    source: "prompt",
    sourceInfo: { path: "/tmp/prompts/interactive-plan.md", source: "top-level", scope: "project", origin: "top-level" },
  };
  const ext = createExtension({ commands: [templateCommand] });
  runForeground(ext, { promptText: "/interactive-plan build a widget", expandedPrompt: "TEMPLATE_BODY\n\nbuild a widget" });
  const { log } = await captureLog(() => invokeCommand(ext));
  const text = log.join("\n");
  assert.ok(text.includes("Prompt template: interactive-plan"), text);
});

test("a system digest mismatch collapses detailed system rows", async () => {
  const ext = createExtension();
  runForeground(ext, {
    systemPrompt: "ORIGINAL_SYSTEM_BEFORE_REPLACEMENT",
    systemOptions: { cwd: "/tmp", contextFiles: [{ path: "/tmp/AGENTS.md", content: "SAFE_AGENTS_CONTENT" }] },
  });
  const { log } = await captureLog(() => invokeCommand(ext));
  const text = log.join("\n");
  assert.ok(text.includes("Final system prompt"), text);
  assert.ok(text.includes("[unattributed]"));
  assert.ok(!text.includes("SAFE_AGENTS_CONTENT"));
  assert.ok(!text.includes("ORIGINAL_SYSTEM_BEFORE_REPLACEMENT"));
});

test("active tool definitions flow into the source report", async () => {
  const tool: ToolInfo = {
    name: "read",
    description: "Read a file.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    sourceInfo: { path: "/tmp/tools/read", source: "builtin", scope: "project", origin: "top-level" },
  };
  const ext = createExtension({ activeTools: ["read"], tools: [tool] });
  runForeground(ext);
  const { log } = await captureLog(() => invokeCommand(ext));
  const text = log.join("\n");
  assert.ok(text.includes("Tools: pi built-in"), text);
});

test("sentinel prompt, result, path, credential, and payload markers never reach output", async () => {
  const skill: Skill = {
    name: "commit",
    description: "safe",
    filePath: "/SAFE_SENTINEL_ROOT/skills/commit/SKILL.md",
    baseDir: "/SAFE_SENTINEL_ROOT/skills/commit",
    sourceInfo: { path: "/SAFE_SENTINEL_ROOT/skills/commit/SKILL.md", source: "top-level", scope: "project", origin: "top-level" },
    disableModelInvocation: false,
  };
  const tool: ToolInfo = {
    name: "mcp_example",
    description: "safe",
    parameters: { type: "object", properties: {} },
    sourceInfo: {
      path: "https://user:SAFE_SENTINEL_PASS@example.test/repo?q=SAFE_SENTINEL_QUERY#SAFE_SENTINEL_FRAG",
      source: "package",
      scope: "project",
      origin: "package",
    },
  };
  const ext = createExtension({ activeTools: ["mcp_example"], tools: [tool] });
  const messages: Record<string, unknown>[] = [
    { role: "user", content: [{ type: "text", text: "SAFE_SENTINEL_PROMPT" }], timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "SAFE_SENTINEL_ASSISTANT" }], timestamp: 2 },
    { role: "toolResult", toolCallId: "call-x", content: [{ type: "text", text: "SAFE_SENTINEL_RESULT" }], timestamp: 3 },
    { role: "custom", customType: "pi-memory-context", content: [{ type: "text", text: "SAFE_SENTINEL_MEMORY" }], timestamp: 4 },
  ];
  const sentinelCtx = createCtx({ getSystemPrompt: () => "SAFE_SENTINEL_SYSTEM" });
  let payloadAccesses = 0;
  const payload = new Proxy(
    { SAFE_SENTINEL_PAYLOAD: true },
    {
      get() {
        payloadAccesses += 1;
        throw new Error("SAFE_SENTINEL_PAYLOAD_READ");
      },
    },
  );
  emit(ext, { type: "session_start", reason: "startup" });
  emit(ext, { type: "input", text: "/SAFE_SENTINEL_PROMPT_TOKEN", source: "interactive" });
  emit(ext, {
    type: "before_agent_start",
    prompt: "SAFE_SENTINEL_PROMPT",
    systemPrompt: "SAFE_SENTINEL_SYSTEM",
    systemPromptOptions: {
      cwd: "/tmp",
      contextFiles: [{ path: "/SAFE_SENTINEL_ROOT/AGENTS.md", content: "SAFE_SENTINEL_FILE" }],
      skills: [skill],
    },
  });
  emit(ext, { type: "agent_start" });
  emit(ext, { type: "context", messages }, sentinelCtx);
  emit(ext, { type: "before_provider_request", payload }, sentinelCtx);
  emit(ext, { type: "message_end", message: assistantMessage({ responseId: "SAFE_SENTINEL_RESPONSE" }) });
  emit(ext, { type: "agent_settled" });
  assert.equal(payloadAccesses, 0, "the payload proxy was accessed");

  const markers = [
    "SAFE_SENTINEL_PROMPT",
    "SAFE_SENTINEL_SYSTEM",
    "SAFE_SENTINEL_FILE",
    "SAFE_SENTINEL_RESULT",
    "SAFE_SENTINEL_ASSISTANT",
    "SAFE_SENTINEL_MEMORY",
    "SAFE_SENTINEL_PASS",
    "SAFE_SENTINEL_QUERY",
    "SAFE_SENTINEL_FRAG",
    "SAFE_SENTINEL_RESPONSE",
    "SAFE_SENTINEL_PAYLOAD",
    "SAFE_SENTINEL_PAYLOAD_READ",
    "SAFE_SENTINEL_ROOT",
    "SAFE_SENTINEL_PROMPT_TOKEN",
    "user:SAFE",
  ];

  const { log } = await captureLog(() => invokeCommand(ext));
  const text = log.join("\n");
  for (const marker of markers) {
    assert.ok(!text.includes(marker), `printed report leaked ${marker}`);
  }
  assert.ok(text.includes("Memory context"), "the memory row must still be attributed");
  assert.ok(text.includes("User history"), "the user row must still be attributed");

  let customCalls = 0;
  let capturedFactory: unknown;
  const tuiCtx = createCtx({
    mode: "tui",
    getSystemPrompt: () => "SAFE_SENTINEL_SYSTEM",
    ui: {
      notify: () => {},
      custom: async (factory: unknown) => {
        customCalls += 1;
        capturedFactory = factory;
        return undefined;
      },
    },
  });
  const tuiLog = await captureLog(() => invokeCommand(ext, "", tuiCtx));
  assert.equal(tuiLog.log.length, 0);
  assert.equal(customCalls, 1);
  const component = (capturedFactory as (tui: unknown, theme: unknown, keybindings: unknown, done: () => void) => { render(width: number): string[]; handleInput(data: string): void })(
    { terminal: { rows: 40 } },
    {},
    {},
    () => {},
  );
  const overlay = component.render(80).join("\n");
  for (const marker of markers) {
    assert.ok(!overlay.includes(marker), `TUI overlay leaked ${marker}`);
  }
});

test("a read of an unknown path creates no skill row", async () => {
  const ext = createExtension();
  runForeground(ext, { toolLoop: true, skillRead: { toolCallId: "call-other", path: "/tmp/unknown.md" } });
  const { log } = await captureLog(() => invokeCommand(ext));
  const text = log.join("\n");
  assert.ok(!text.includes("Skill body:"), text);
  assert.ok(text.includes("Tool results"), text);
});

test("raw system options never outlive the before_agent_start hook", async () => {
  const ext = createExtension();
  let contextFilesReads = 0;
  const proxyOptions = new Proxy(
    { ...SYSTEM_OPTIONS },
    {
      get(target, prop, receiver) {
        if (prop === "contextFiles") contextFilesReads += 1;
        return Reflect.get(target, prop, receiver);
      },
    },
  );
  emit(ext, { type: "session_start", reason: "startup" });
  emit(ext, { type: "input", text: "hello", source: "interactive" });
  emit(ext, { type: "before_agent_start", prompt: "hello", systemPrompt: SYSTEM_PROMPT, systemPromptOptions: proxyOptions });
  const readsAfterBeforeAgentStart = contextFilesReads;
  emit(ext, { type: "agent_start" });
  emit(ext, { type: "context", messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }] });
  emit(ext, { type: "before_provider_request", payload: {} });
  emit(ext, { type: "message_end", message: assistantMessage() });
  emit(ext, { type: "agent_settled" });
  assert.equal(
    contextFilesReads,
    readsAfterBeforeAgentStart,
    "the context hook re-read the raw system options retained by before_agent_start",
  );
});

test("streaming steer and followUp inputs never overwrite the idle prompt classification", async () => {
  const skillCommand: SlashCommandInfo = {
    name: "skill:commit",
    source: "skill",
    sourceInfo: { path: "/tmp/skills/commit", source: "top-level", scope: "project", origin: "top-level" },
  };
  for (const streamingBehavior of ["steer", "followUp"] as const) {
    const ext = createExtension({ commands: [skillCommand] });
    emit(ext, { type: "session_start", reason: "startup" });
    emit(ext, { type: "input", text: "hello", source: "interactive" });
    emit(ext, { type: "before_agent_start", prompt: "hello", systemPrompt: SYSTEM_PROMPT, systemPromptOptions: SYSTEM_OPTIONS });
    emit(ext, { type: "agent_start" });
    emit(ext, { type: "input", text: "/skill:commit fix the bug", source: "interactive", streamingBehavior });
    emit(ext, { type: "context", messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }] });
    emit(ext, { type: "before_provider_request", payload: {} });
    emit(ext, { type: "message_end", message: assistantMessage() });
    emit(ext, { type: "agent_settled" });
    const { log } = await captureLog(() => invokeCommand(ext));
    const text = log.join("\n");
    assert.ok(!text.includes("Skill: commit"), `${streamingBehavior} relabeled the original plain prompt`);
    assert.ok(text.includes("User history"), `${streamingBehavior} lost the plain prompt row`);
  }
});

test("a streaming steer never removes an existing skill classification", async () => {
  const skillCommand: SlashCommandInfo = {
    name: "skill:commit",
    source: "skill",
    sourceInfo: { path: "/tmp/skills/commit", source: "top-level", scope: "project", origin: "top-level" },
  };
  const ext = createExtension({ commands: [skillCommand] });
  emit(ext, { type: "session_start", reason: "startup" });
  emit(ext, { type: "input", text: "/skill:commit fix the bug", source: "interactive" });
  emit(ext, { type: "before_agent_start", prompt: "SKILL_BODY\n\nfix the bug", systemPrompt: SYSTEM_PROMPT, systemPromptOptions: SYSTEM_OPTIONS });
  emit(ext, { type: "agent_start" });
  emit(ext, { type: "input", text: "continue", source: "interactive", streamingBehavior: "steer" });
  emit(ext, { type: "context", messages: [{ role: "user", content: [{ type: "text", text: "SKILL_BODY\n\nfix the bug" }], timestamp: 1 }] });
  emit(ext, { type: "before_provider_request", payload: {} });
  emit(ext, { type: "message_end", message: assistantMessage() });
  emit(ext, { type: "agent_settled" });
  const { log } = await captureLog(() => invokeCommand(ext));
  const text = log.join("\n");
  assert.ok(text.includes("Skill: commit"), "a plain steer removed the original skill classification");
});

test("a canceled compaction does not suppress the next foreground request", async () => {
  const ext = createExtension();
  emit(ext, { type: "session_start", reason: "startup" });
  emit(ext, { type: "input", text: "hello", source: "interactive" });
  emit(ext, { type: "before_agent_start", prompt: "hello", systemPrompt: SYSTEM_PROMPT, systemPromptOptions: SYSTEM_OPTIONS });
  emit(ext, { type: "agent_start" });
  emit(ext, { type: "context", messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }] });
  emit(ext, { type: "session_before_compact" });
  emit(ext, { type: "before_provider_request", payload: {} });
  // The compaction is canceled: session_compact never fires.
  emit(ext, { type: "agent_settled" });
  emit(ext, { type: "input", text: "hello again", source: "interactive" });
  emit(ext, { type: "before_agent_start", prompt: "hello again", systemPrompt: SYSTEM_PROMPT, systemPromptOptions: SYSTEM_OPTIONS });
  emit(ext, { type: "agent_start" });
  emit(ext, { type: "context", messages: [{ role: "user", content: [{ type: "text", text: "hello again" }], timestamp: 2 }] });
  emit(ext, { type: "before_provider_request", payload: {} });
  emit(ext, { type: "message_end", message: assistantMessage() });
  emit(ext, { type: "agent_settled" });
  const { log } = await captureLog(() => invokeCommand(ext));
  const text = log.join("\n");
  assert.ok(text.includes("Context attribution — latest foreground request #2"), text);
  assert.ok(text.includes("Scope: foreground normal request [recorded]"), text);
  assert.ok(text.includes("  Eligible requests: 2"), text);
  assert.ok(text.includes("  Complete provider usage: 1"), text);
  assert.ok(text.includes("  Excluded provider calls: 1"), text);
});

test("a canceled tree operation does not suppress the next foreground request", async () => {
  const ext = createExtension();
  emit(ext, { type: "session_start", reason: "startup" });
  emit(ext, { type: "input", text: "hello", source: "interactive" });
  emit(ext, { type: "before_agent_start", prompt: "hello", systemPrompt: SYSTEM_PROMPT, systemPromptOptions: SYSTEM_OPTIONS });
  emit(ext, { type: "agent_start" });
  emit(ext, { type: "context", messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }] });
  emit(ext, { type: "session_before_tree" });
  emit(ext, { type: "before_provider_request", payload: {} });
  // The tree navigation is canceled: session_tree never fires.
  emit(ext, { type: "agent_settled" });
  emit(ext, { type: "input", text: "hello again", source: "interactive" });
  emit(ext, { type: "before_agent_start", prompt: "hello again", systemPrompt: SYSTEM_PROMPT, systemPromptOptions: SYSTEM_OPTIONS });
  emit(ext, { type: "agent_start" });
  emit(ext, { type: "context", messages: [{ role: "user", content: [{ type: "text", text: "hello again" }], timestamp: 2 }] });
  emit(ext, { type: "before_provider_request", payload: {} });
  emit(ext, { type: "message_end", message: assistantMessage() });
  emit(ext, { type: "agent_settled" });
  const { log } = await captureLog(() => invokeCommand(ext));
  const text = log.join("\n");
  assert.ok(text.includes("Context attribution — latest foreground request #2"), text);
  assert.ok(text.includes("Scope: foreground normal request [recorded]"), text);
  assert.ok(text.includes("  Eligible requests: 2"), text);
  assert.ok(text.includes("  Complete provider usage: 1"), text);
  assert.ok(text.includes("  Excluded provider calls: 1"), text);
});

