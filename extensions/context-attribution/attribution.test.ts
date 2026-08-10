import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { formatSkillsForPrompt as publicFormatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import type { Skill, SlashCommandInfo, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { attributeContext, classifyPromptSource, formatSkillsForPrompt, keyedDigest, matchSkillPathDigest } from "./attribution.ts";
import type { SystemAttributionInput } from "./attribution.ts";

const CWD = "/Users/alice/project";

function skillFixture(name: string, description: string): Skill {
  return {
    name,
    description,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    sourceInfo: { path: `/skills/${name}/SKILL.md`, source: "user", scope: "user", origin: "top-level" },
    disableModelInvocation: false,
  };
}

interface PromptFixtureOptions {
  customPrompt?: string;
  appendSystemPrompt?: string;
  contextFiles?: Array<{ path: string; content: string }>;
  skills?: Skill[];
  toolSnippets?: Record<string, string>;
  promptGuidelines?: string[];
  selectedTools?: string[];
  cwd: string;
}

/** Replicates the approved core buildSystemPrompt composition for fixtures. */
function buildPromptFixture(options: PromptFixtureOptions): string {
  const promptCwd = options.cwd.replace(/\\/g, "/");
  const appendSection = options.appendSystemPrompt ? `\n\n${options.appendSystemPrompt}` : "";
  const contextFiles = options.contextFiles ?? [];
  const skills = options.skills ?? [];
  if (options.customPrompt) {
    let prompt = options.customPrompt;
    if (appendSection) prompt += appendSection;
    if (contextFiles.length > 0) {
      prompt += "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
      for (const { path: filePath, content } of contextFiles) {
        prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
      }
      prompt += "</project_context>\n";
    }
    const hasRead = !options.selectedTools || options.selectedTools.includes("read");
    if (hasRead && skills.length > 0) prompt += formatSkillsForPrompt(skills);
    prompt += `\nCurrent working directory: ${promptCwd}`;
    return prompt;
  }
  const tools = options.selectedTools ?? ["read", "bash", "edit", "write"];
  const visibleTools = tools.filter((name) => !!options.toolSnippets?.[name]);
  const toolsList = visibleTools.length > 0
    ? visibleTools.map((name) => `- ${name}: ${options.toolSnippets![name]}`).join("\n")
    : "(none)";
  const guidelines: string[] = [];
  const seen = new Set<string>();
  const addGuideline = (guideline: string) => {
    if (seen.has(guideline)) return;
    seen.add(guideline);
    guidelines.push(guideline);
  };
  const hasBash = tools.includes("bash");
  const hasGrep = tools.includes("grep");
  const hasFind = tools.includes("find");
  const hasLs = tools.includes("ls");
  if (hasBash && !hasGrep && !hasFind && !hasLs) addGuideline("Use bash for file operations like ls, rg, find");
  for (const guideline of options.promptGuidelines ?? []) {
    const normalized = guideline.trim();
    if (normalized.length > 0) addGuideline(normalized);
  }
  addGuideline("Be concise in your responses");
  addGuideline("Show file paths clearly when working with files");
  const guidelinesList = guidelines.map((g) => `- ${g}`).join("\n");
  let prompt = "You are an expert coding assistant operating inside pi.\n\nAvailable tools:\n" + toolsList + "\n\nGuidelines:\n" + guidelinesList;
  if (appendSection) prompt += appendSection;
  if (contextFiles.length > 0) {
    prompt += "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
    for (const { path: filePath, content } of contextFiles) {
      prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
    }
    prompt += "</project_context>\n";
  }
  const hasRead = tools.includes("read");
  if (hasRead && skills.length > 0) prompt += formatSkillsForPrompt(skills);
  prompt += `\nCurrent working directory: ${promptCwd}`;
  return prompt;
}

function emptySystem(): SystemAttributionInput {
  return { systemPrompt: "synthetic system prompt", options: { cwd: "/tmp" }, matchesCurrent: true };
}

function rowMap(rows: readonly { key: string }[]) {
  return new Map(rows.map((row) => [row.key, row]));
}

test("attributes exposed system sources with a stable non-overlapping remainder", () => {
  const instructions = [
    { path: "AGENTS.md", content: "First instruction file content." },
    { path: "CLAUDE.md", content: "Second instruction file content." },
  ];
  const skills = [skillFixture("build", "Build the project."), skillFixture("test", "Run the tests.")];
  const options = {
    cwd: CWD,
    contextFiles: instructions,
    skills,
    appendSystemPrompt: "Append text here.",
    toolSnippets: { read: "Read a file from disk.", bash: "Run a shell command." },
    promptGuidelines: ["Write short functions.", "Keep the changes small."],
    selectedTools: ["read", "bash"],
  };
  const prompt = buildPromptFixture(options);
  const rows = attributeContext({ system: { systemPrompt: prompt, options, matchesCurrent: true }, messages: [], activeTools: [], allTools: [] });
  const byKey = rowMap(rows);

  assert.equal(byKey.get("system:append")!.characters.value, options.appendSystemPrompt.length);
  assert.equal(byKey.get("system:instruction:0")!.characters.value, instructions[0].content.length);
  assert.equal(byKey.get("system:instruction:1")!.characters.value, instructions[1].content.length);
  assert.equal(byKey.get("system:instruction:0")!.label, "$CWD/AGENTS.md");
  assert.equal(byKey.get("system:instruction:1")!.label, "$CWD/CLAUDE.md");
  assert.equal(byKey.get("system:skill-catalog")!.characters.value, formatSkillsForPrompt(skills).length);
  assert.equal(byKey.get("system:skill-catalog")!.itemCount.value, 2);
  assert.equal(byKey.get("system:tool-snippets")!.characters.value, options.toolSnippets.read.length + options.toolSnippets.bash.length);
  assert.equal(byKey.get("system:guidelines")!.characters.value, options.promptGuidelines[0].length + options.promptGuidelines[1].length);
  assert.equal(byKey.get("system:cwd")!.characters.value, CWD.length);
  assert.equal(byKey.get("system:cwd")!.label, "$CWD");

  const remainder = byKey.get("system:remainder")!;
  assert.equal(remainder.category, "system");
  assert.equal(remainder.attribution, "unattributed");
  assert.ok(remainder.characters.value! > 0);
  const claimed = rows.filter((row) => row.key !== "system:remainder").reduce((sum, row) => sum + (row.characters.value ?? 0), 0);
  assert.equal(remainder.characters.value, prompt.length - claimed);
  assert.ok(!byKey.has("system:custom-prompt"));
});

test("custom prompt mode claims the custom base, append, instructions, catalog, and cwd", () => {
  const customPrompt = "You are a custom assistant. Follow these rules carefully.";
  const skills = [skillFixture("demo", "Demo skill description.")];
  const options = {
    cwd: CWD,
    customPrompt,
    skills,
    contextFiles: [{ path: "AGENTS.md", content: "Custom project rules." }],
    appendSystemPrompt: "Custom append.",
  };
  const prompt = buildPromptFixture(options);
  const rows = attributeContext({ system: { systemPrompt: prompt, options, matchesCurrent: true }, messages: [], activeTools: [], allTools: [] });
  const byKey = rowMap(rows);
  assert.equal(byKey.get("system:custom-prompt")!.characters.value, customPrompt.length);
  assert.equal(byKey.get("system:custom-prompt")!.category, "system");
  assert.equal(byKey.get("system:instruction:0")!.characters.value, "Custom project rules.".length);
  assert.equal(byKey.get("system:append")!.characters.value, "Custom append.".length);
  assert.equal(byKey.get("system:skill-catalog")!.characters.value, formatSkillsForPrompt(skills).length);
  assert.equal(byKey.get("system:cwd")!.characters.value, CWD.length);
  assert.ok(!byKey.has("system:tool-snippets"));
  assert.ok(!byKey.has("system:guidelines"));
});

test("duplicate source text allocates non-overlapping spans", () => {
  const shared = "This exact instruction text appears twice in the system prompt.";
  const options = {
    cwd: CWD,
    contextFiles: [
      { path: "AGENTS.md", content: shared },
      { path: "CLAUDE.md", content: shared },
    ],
  };
  const prompt = buildPromptFixture(options);
  const rows = attributeContext({ system: { systemPrompt: prompt, options, matchesCurrent: true }, messages: [], activeTools: [], allTools: [] });
  const byKey = rowMap(rows);
  assert.equal(byKey.get("system:instruction:0")!.characters.value, shared.length);
  assert.equal(byKey.get("system:instruction:1")!.characters.value, shared.length);
  const claimed = rows.filter((row) => row.key !== "system:remainder").reduce((sum, row) => sum + (row.characters.value ?? 0), 0);
  assert.ok(claimed <= prompt.length);
  assert.equal(claimed, shared.length * 2 + CWD.length);
  const remainder = byKey.get("system:remainder")!;
  assert.equal(remainder.characters.value, prompt.length - claimed);
  assert.equal(remainder.attribution, "unattributed");
});

test("a system digest mismatch requests one unattributed final-system row", () => {
  const options = { cwd: CWD, contextFiles: [{ path: "AGENTS.md", content: "A" }], appendSystemPrompt: "B" };
  const prompt = buildPromptFixture(options);
  const rows = attributeContext({ system: { systemPrompt: prompt, options, matchesCurrent: false }, messages: [], activeTools: [], allTools: [] });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.key, "system:final");
  assert.equal(row.category, "system");
  assert.equal(row.attribution, "unattributed");
  assert.equal(row.characters.measurement, "estimated");
  assert.equal(row.characters.value, prompt.length);
  assert.equal(row.tokens.measurement, "estimated");
  assert.equal(row.warning, "system-digest-mismatch");
});

test("classifies plain, skill-command, and prompt-template input", () => {
  const commands: SlashCommandInfo[] = [
    { name: "skill:build", description: "Build", source: "skill", sourceInfo: { path: "/skills/build/SKILL.md", source: "user", scope: "user", origin: "top-level" } },
    { name: "interactive-plan", description: "Plan", source: "prompt", sourceInfo: { path: "/prompts/interactive-plan.md", source: "user", scope: "user", origin: "top-level" } },
    { name: "reload", description: "Reload", source: "extension", sourceInfo: { path: "/extensions/reload.ts", source: "local", scope: "user", origin: "top-level" } },
  ];
  assert.deepEqual(classifyPromptSource("fix the build", commands), { kind: "plain" });
  assert.deepEqual(classifyPromptSource("/skill:build with extra args", commands), { kind: "skill", name: "build" });
  assert.deepEqual(classifyPromptSource("/interactive-plan design the module", commands), { kind: "prompt", name: "interactive-plan" });
  assert.deepEqual(classifyPromptSource("/unknown-command text", commands), { kind: "plain" });
});

test("groups every approved conversation block category separately", () => {
  const unknownMessage = { role: "mysteryRole", content: "mystery payload" };
  const toolArgs = { path: "/tmp/project/src/main.ts" };
  const messages = [
    { role: "user", content: "First user question about the codebase.", timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Let me check the code first." },
        { type: "thinking", thinking: "I need to look at the file structure." },
        { type: "toolCall", id: "call-1", name: "read", arguments: toolArgs },
      ],
      api: "openai", provider: "openai", model: "gpt-test",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse", timestamp: 2,
    },
    { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "The main file contains the entry point." }], isError: false, timestamp: 3 },
    { role: "custom", customType: "example-extension", content: "Custom extension content.", display: true, timestamp: 4 },
    { role: "bashExecution", command: "npm test", output: "1 passing", exitCode: 0, cancelled: false, truncated: false, timestamp: 5 },
    { role: "branchSummary", summary: "Branch summary text.", fromId: "e1", timestamp: 6 },
    { role: "compactionSummary", summary: "Earlier history was summarized.", tokensBefore: 1000, timestamp: 7 },
    unknownMessage as unknown as AgentMessage,
    { role: "user", content: [{ type: "text", text: "Current prompt text." }], timestamp: 8 },
  ] as unknown as AgentMessage[];
  const rows = attributeContext({ system: emptySystem(), messages, promptSource: { kind: "plain" }, activeTools: [], allTools: [] });
  const byKey = rowMap(rows);

  assert.equal(byKey.get("msg:user")!.category, "conversation");
  assert.equal(byKey.get("msg:user")!.label, "User history");
  assert.equal(byKey.get("msg:user")!.characters.value, "First user question about the codebase.".length + "Current prompt text.".length);
  assert.equal(byKey.get("msg:user")!.itemCount.value, 2);

  assert.equal(byKey.get("msg:assistant")!.category, "assistant");
  assert.equal(byKey.get("msg:assistant")!.characters.value, "Let me check the code first.".length);

  assert.equal(byKey.get("msg:thinking")!.category, "thinking");
  assert.equal(byKey.get("msg:thinking")!.characters.value, "I need to look at the file structure.".length);

  assert.equal(byKey.get("msg:tool-call")!.category, "tool-call");
  assert.equal(byKey.get("msg:tool-call")!.characters.value, JSON.stringify(toolArgs).length);
  assert.equal(byKey.get("msg:tool-call")!.itemCount.value, 1);

  assert.equal(byKey.get("msg:tool-result")!.category, "tool-result");
  assert.equal(byKey.get("msg:tool-result")!.characters.value, "The main file contains the entry point.".length);

  assert.equal(byKey.get("msg:custom:example-extension")!.category, "custom");
  assert.equal(byKey.get("msg:custom:example-extension")!.label, "Extension: example-extension");
  assert.equal(byKey.get("msg:custom:example-extension")!.characters.value, "Custom extension content.".length);

  assert.equal(byKey.get("msg:bash")!.label, "Bash execution");
  assert.equal(byKey.get("msg:bash")!.characters.value, "npm test".length + "1 passing".length);

  assert.equal(byKey.get("msg:branch-summary")!.category, "summary");
  assert.equal(byKey.get("msg:branch-summary")!.attribution, "attributed");
  assert.equal(byKey.get("msg:branch-summary")!.characters.value, "Branch summary text.".length);

  assert.equal(byKey.get("msg:compaction-summary")!.category, "summary");
  assert.equal(byKey.get("msg:compaction-summary")!.attribution, "unattributed");
  assert.equal(byKey.get("msg:compaction-summary")!.characters.value, "Earlier history was summarized.".length);

  assert.equal(byKey.get("msg:unknown")!.category, "unattributed");
  assert.equal(byKey.get("msg:unknown")!.attribution, "unattributed");
  assert.equal(byKey.get("msg:unknown")!.characters.value, JSON.stringify(unknownMessage).length);
});

test("maps known memory custom types to fixed categories", () => {
  const messages = [
    { role: "custom", customType: "pi-memory-context", content: "Memory facts about the project.", display: false, timestamp: 1 },
    { role: "custom", customType: "pi-session-search-primer", content: "Recent sessions primer.", display: false, timestamp: 2 },
    { role: "custom", customType: "knowledge-overview", content: "Knowledge index overview.", display: false, timestamp: 3 },
    { role: "custom", customType: "some-other-extension", content: "Generic extension payload.", display: true, timestamp: 4 },
  ] as unknown as AgentMessage[];
  const rows = attributeContext({ system: emptySystem(), messages, activeTools: [], allTools: [] });
  const byKey = rowMap(rows);
  assert.equal(byKey.get("msg:memory:pi-memory-context")!.category, "memory");
  assert.equal(byKey.get("msg:memory:pi-memory-context")!.label, "Memory context");
  assert.equal(byKey.get("msg:memory:pi-memory-context")!.characters.value, "Memory facts about the project.".length);
  assert.equal(byKey.get("msg:memory:pi-session-search-primer")!.label, "Session search primer");
  assert.equal(byKey.get("msg:memory:pi-session-search-primer")!.characters.value, "Recent sessions primer.".length);
  assert.equal(byKey.get("msg:memory:knowledge-overview")!.label, "Knowledge overview");
  assert.equal(byKey.get("msg:memory:knowledge-overview")!.characters.value, "Knowledge index overview.".length);
  assert.equal(byKey.get("msg:custom:some-other-extension")!.label, "Extension: some-other-extension");
});

test("attributes a recognized skill read through a keyed path digest and tool-call ID", () => {
  const messages = [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "/skills/commit/SKILL.md" } }],
      api: "openai", provider: "openai", model: "gpt-test",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse", timestamp: 1,
    },
    { role: "toolResult", toolCallId: "call-read", toolName: "read", content: [{ type: "text", text: "Skill body content that the model received." }], isError: false, timestamp: 2 },
  ] as unknown as AgentMessage[];
  const skillReads = new Map([["call-read", "commit"]]);
  const rows = attributeContext({ system: emptySystem(), messages, promptSource: { kind: "plain" }, skillReads, activeTools: [], allTools: [] });
  const byKey = rowMap(rows);
  assert.equal(byKey.get("msg:skill-read:commit")!.category, "skills");
  assert.equal(byKey.get("msg:skill-read:commit")!.label, "Skill body: commit");
  assert.equal(byKey.get("msg:skill-read:commit")!.characters.value, "Skill body content that the model received.".length);
  assert.ok(!byKey.has("msg:tool-result"));
});

test("counts images with the approved estimate and never returns their data", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "Look at this image." }, { type: "image", data: "data:image/png;base64,SAFE_IMAGE_PAYLOAD", mimeType: "image/png" }], timestamp: 1 },
    { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "image", data: "data:image/png;base64,SECOND_IMAGE", mimeType: "image/png" }], isError: false, timestamp: 2 },
  ] as unknown as AgentMessage[];
  const rows = attributeContext({ system: emptySystem(), messages, promptSource: { kind: "plain" }, activeTools: [], allTools: [] });
  const byKey = rowMap(rows);
  assert.equal(byKey.get("msg:images")!.category, "images");
  assert.equal(byKey.get("msg:images")!.itemCount.value, 2);
  assert.equal(byKey.get("msg:images")!.characters.value, 2 * 4_800);
  assert.equal(byKey.get("msg:images")!.characters.measurement, "estimated");
  const serialized = JSON.stringify(rows);
  assert.ok(!serialized.includes("SAFE_IMAGE_PAYLOAD"));
  assert.ok(!serialized.includes("SECOND_IMAGE"));
});

test("counts only active tools and groups them by sanitized provenance", () => {
  const allTools = [
    { name: "read", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } } }, sourceInfo: { path: "<builtin:read>", source: "builtin", scope: "temporary", origin: "top-level" } },
    { name: "bash", description: "Run a command.", parameters: { type: "object" }, sourceInfo: { path: "<builtin:bash>", source: "builtin", scope: "temporary", origin: "top-level" } },
    { name: "edit", description: "Edit a file.", parameters: { type: "object" }, sourceInfo: { path: "<builtin:edit>", source: "builtin", scope: "temporary", origin: "top-level" } },
    { name: "my_tool", description: "Extension tool.", parameters: { type: "object" }, sourceInfo: { path: "/Users/mathu/.pi/agent/extensions/sample-tool.ts", source: "local", scope: "user", origin: "top-level" } },
    { name: "parallel_search_web_search", description: "Search the web.", parameters: { type: "object" }, sourceInfo: { path: "<git:github.com/nicobailon/pi-mcp-adapter>index.ts", source: "git", scope: "project", origin: "package" } },
  ] as ToolInfo[];
  const rows = attributeContext({
    system: emptySystem(),
    messages: [],
    activeTools: ["read", "bash", "my_tool", "parallel_search_web_search"],
    allTools,
    cwd: "/Users/mathu/.pi/agent",
  });
  const byKey = rowMap(rows);

  const builtin = byKey.get("tools:pi built-in")!;
  assert.equal(builtin.category, "tools");
  assert.equal(builtin.label, "Tools: pi built-in");
  assert.equal(builtin.itemCount.value, 2);
  assert.equal(builtin.characters.value, JSON.stringify({ name: "read", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } } } }).length + JSON.stringify({ name: "bash", description: "Run a command.", parameters: { type: "object" } }).length);

  const extension = byKey.get("tools:user:top-level:$CWD/extensions/sample-tool.ts")!;
  assert.equal(extension.label, "Tools: user/top-level/$CWD/extensions/sample-tool.ts");
  assert.equal(extension.itemCount.value, 1);
  assert.equal(extension.label.includes("Users"), false);

  const adapter = byKey.get("tools:project:package:git/github.com/nicobailon/pi-mcp-adapter")!;
  assert.equal(adapter.label, "Tools: project/package/git/github.com/nicobailon/pi-mcp-adapter");
  assert.equal(adapter.itemCount.value, 1);

  assert.ok(!byKey.has("tools:" + "edit"));
  const editFound = rows.some((row) => row.label.includes("edit") && row.category === "tools");
  assert.equal(editFound, false);
});

test("marks tool schema serialization failure unavailable with a fixed warning", () => {
  const cyclic: Record<string, unknown> = { type: "object" };
  cyclic.self = cyclic;
  const allTools = [
    { name: "broken", description: "Broken schema tool.", parameters: cyclic, sourceInfo: { path: "<builtin:broken>", source: "builtin", scope: "temporary", origin: "top-level" } },
  ] as ToolInfo[];
  const rows = attributeContext({ system: emptySystem(), messages: [], activeTools: ["broken"], allTools, cwd: "/tmp" });
  const row = rows.find((r) => r.category === "tools")!;
  assert.equal(row.warning, "serialization-unavailable");
  assert.equal(row.characters.measurement, "unavailable");
  assert.equal(row.tokens.measurement, "unavailable");
  assert.equal(row.itemCount.value, 1);
  const serialized = JSON.stringify(rows);
  assert.ok(!serialized.includes("Broken schema tool."));
  assert.ok(!serialized.includes("cyclic"));
});

test("a unique secret marker in every raw source never appears in returned rows", () => {
  const markers = {
    system: "MARKER_SYS_77aa",
    custom: "MARKER_CUSTOM_31bb",
    append: "MARKER_APPEND_42cc",
    instructions: "MARKER_INSTRUCTIONS_53dd",
    skillDesc: "MARKER_SKILL_64ee",
    snippet: "MARKER_SNIPPET_75ff",
    guideline: "MARKER_GUIDELINE_86a1",
    cwd: "MARKER_CWD_97b2",
    user: "MARKER_USER_a8c3",
    assistant: "MARKER_ASSISTANT_b9d4",
    thinking: "MARKER_THINKING_c0e5",
    toolArgs: "MARKER_TOOLARGS_d1f6",
    result: "MARKER_RESULT_e2a7",
    customMsg: "MARKER_CUSTOMMSG_f3b8",
    bash: "MARKER_BASH_04c9",
    bashOut: "MARKER_BASHOUT_15da",
    branch: "MARKER_BRANCH_26eb",
    compaction: "MARKER_COMPACTION_37fc",
    toolDesc: "MARKER_TOOLDESC_48ad",
    toolParam: "MARKER_TOOLPARAM_59be",
    image: "MARKER_IMAGE_60cf",
  };
  const skill = skillFixture("secret-skill", `Description with ${markers.skillDesc}.`);
  const options = {
    cwd: CWD,
    customPrompt: `Custom base with ${markers.custom}.`,
    appendSystemPrompt: `Append with ${markers.append}.`,
    contextFiles: [{ path: "AGENTS.md", content: `Instructions with ${markers.instructions}.` }],
    skills: [skill],
    toolSnippets: { read: `Snippet with ${markers.snippet}.` },
    promptGuidelines: [`Guideline with ${markers.guideline}.`],
  };
  const prompt = buildPromptFixture(options);
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: `User prompt with ${markers.user}.` },
        { type: "image", data: markers.image, mimeType: "image/png" },
      ],
      timestamp: 1,
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: `Assistant with ${markers.assistant}.` },
        { type: "thinking", thinking: `Thinking with ${markers.thinking}.` },
        { type: "toolCall", id: "call-x", name: "read", arguments: { path: `args with ${markers.toolArgs}` } },
      ],
      api: "openai", provider: "openai", model: "gpt-test",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse", timestamp: 2,
    },
    { role: "toolResult", toolCallId: "call-x", toolName: "read", content: [{ type: "text", text: `Result with ${markers.result}.` }], isError: false, timestamp: 3 },
    { role: "custom", customType: "secret-extension", content: `Custom with ${markers.customMsg}.`, display: true, timestamp: 4 },
    { role: "bashExecution", command: `echo ${markers.bash}`, output: markers.bashOut, exitCode: 0, cancelled: false, truncated: false, timestamp: 5 },
    { role: "branchSummary", summary: `Branch with ${markers.branch}.`, fromId: "e", timestamp: 6 },
    { role: "compactionSummary", summary: `Compact with ${markers.compaction}.`, tokensBefore: 1, timestamp: 7 },
  ] as unknown as AgentMessage[];
  const allTools = [
    { name: "secret_tool", description: `Tool desc with ${markers.toolDesc}.`, parameters: { type: "object", properties: { key: { type: "string", description: `param with ${markers.toolParam}` } } }, sourceInfo: { path: "<builtin:secret_tool>", source: "builtin", scope: "temporary", origin: "top-level" } },
  ] as ToolInfo[];
  const rows = attributeContext({
    system: { systemPrompt: prompt, options, matchesCurrent: true },
    messages,
    promptSource: { kind: "plain" },
    activeTools: ["secret_tool"],
    allTools,
    cwd: CWD,
  });
  const serialized = JSON.stringify(rows);
  for (const marker of Object.values(markers)) {
    assert.ok(!serialized.includes(marker), `returned rows leaked ${marker}`);
  }
  assert.ok(serialized.length > 0);
});

test("a generic user-role extension message after the current prompt stays unattributed", () => {
  const skillPrompt = "build";
  const extensionText = "extension text";
  const messages = [
    { role: "user", content: skillPrompt, timestamp: 1 },
    { role: "user", content: extensionText, timestamp: 2 },
  ] as unknown as AgentMessage[];
  const rows = attributeContext({ system: emptySystem(), messages, promptSource: { kind: "skill", name: "build" }, activeTools: [], allTools: [] });
  const byKey = rowMap(rows);
  assert.equal(byKey.get("msg:skill-prompt")!.characters.value, skillPrompt.length);
  assert.equal(byKey.get("msg:skill-prompt")!.label, "Skill: build");
  const extensionRow = byKey.get("msg:user-unattributed")!;
  assert.equal(extensionRow.characters.value, extensionText.length);
  assert.equal(extensionRow.attribution, "unattributed");
  assert.equal(extensionRow.label, "User text without source metadata");
  assert.ok(!byKey.has("msg:user"));
});

test("an unmatched skill read tool result stays plain tool output", () => {
  const messages = [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-other", name: "read", arguments: { path: "/other/file.md" } }],
      api: "openai", provider: "openai", model: "gpt-test",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse", timestamp: 1,
    },
    { role: "toolResult", toolCallId: "call-other", toolName: "read", content: [{ type: "text", text: "Unmatched body content." }], isError: false, timestamp: 2 },
  ] as unknown as AgentMessage[];
  const skillReads = new Map([["call-read", "commit"]]);
  const rows = attributeContext({ system: emptySystem(), messages, promptSource: { kind: "plain" }, skillReads, activeTools: [], allTools: [] });
  const byKey = rowMap(rows);
  assert.equal(byKey.get("msg:tool-result")!.characters.value, "Unmatched body content.".length);
  assert.ok(!byKey.has("msg:skill-read:commit"));
});

test("a context-prune summary row is unattributed with no detailed source", () => {
  const messages = [
    { role: "custom", customType: "context-prune-summary", content: "Pruned tool results were summarized.", display: false, timestamp: 1 },
  ] as unknown as AgentMessage[];
  const rows = attributeContext({ system: emptySystem(), messages, activeTools: [], allTools: [] });
  const byKey = rowMap(rows);
  assert.equal(byKey.get("msg:prune-summary")!.category, "summary");
  assert.equal(byKey.get("msg:prune-summary")!.attribution, "unattributed");
  assert.equal(byKey.get("msg:prune-summary")!.characters.value, "Pruned tool results were summarized.".length);
});

test("wrapped tool provenance with a control-bearing credential URL is sanitized", () => {
  const wrapped = "<git:https\u0000://user:pass@example.test/repo?q=secret#x>index.ts";
  const allTools = [
    { name: "mcp_do", description: "Do a thing.", parameters: { type: "object" }, sourceInfo: { path: wrapped, source: "git", scope: "project", origin: "package" } },
  ] as ToolInfo[];
  const rows = attributeContext({ system: emptySystem(), messages: [], activeTools: ["mcp_do"], allTools, cwd: "/Users/mathu/.pi/agent" });
  const serialized = JSON.stringify(rows);
  assert.ok(!serialized.includes("user:pass"), "returned rows leaked credentials");
  assert.ok(!serialized.includes("?q=secret"), "returned rows leaked query data");
  assert.ok(!serialized.includes("#x"), "returned rows leaked a fragment");
  const row = rows.find((r) => r.category === "tools")!;
  assert.equal(row.key, "tools:project:package:git/https://example.test/repo");
  assert.equal(row.label, "Tools: project/package/git/https://example.test/repo");
});

test("control-bearing URL custom types never leak credentials or query data", () => {
  const controlUrl = "https\u0000://user:pass@example.test/repo?q=secret#x";
  const messages = [
    { role: "custom", customType: controlUrl, content: "payload", display: true, timestamp: 1 },
  ] as unknown as AgentMessage[];
  const rows = attributeContext({ system: emptySystem(), messages, activeTools: [], allTools: [] });
  const serialized = JSON.stringify(rows);
  assert.ok(!serialized.includes("user:pass"), "returned rows leaked credentials");
  assert.ok(!serialized.includes("?q=secret"), "returned rows leaked query data");
  assert.ok(!serialized.includes("#x"), "returned rows leaked a fragment");
  const row = rows.find((r) => r.key.startsWith("msg:custom:"))!;
  assert.equal(row.label, "Extension: https://example.test/repo");
});

test("inactive tool snippets are not claimed and guidelines are trimmed and deduplicated", () => {
  const options = {
    cwd: CWD,
    selectedTools: ["read", "bash"],
    toolSnippets: { read: "Read a file from disk.", bash: "Run a shell command.", grep: "Search text." },
    promptGuidelines: ["Search text.", "  Search text.  ", "   "],
  };
  const prompt = buildPromptFixture(options);
  const rows = attributeContext({ system: { systemPrompt: prompt, options, matchesCurrent: true }, messages: [], activeTools: [], allTools: [] });
  const byKey = rowMap(rows);
  assert.equal(byKey.get("system:tool-snippets")!.characters.value, options.toolSnippets.read.length + options.toolSnippets.bash.length);
  assert.equal(byKey.get("system:tool-snippets")!.itemCount.value, 2);
  assert.equal(byKey.get("system:guidelines")!.characters.value, "Search text.".length);
  assert.equal(byKey.get("system:guidelines")!.itemCount.value, 1);
});

test("tool grouping preserves scope and origin so distinct sources cannot collapse", () => {
  const allTools = [
    { name: "tool_a", description: "A", parameters: { type: "object" }, sourceInfo: { path: "/Users/alice/project/ext/tool.ts", source: "local", scope: "user", origin: "top-level" } },
    { name: "tool_b", description: "B", parameters: { type: "object" }, sourceInfo: { path: "/Users/alice/project/ext/tool.ts", source: "local", scope: "project", origin: "package" } },
  ] as ToolInfo[];
  const rows = attributeContext({ system: emptySystem(), messages: [], activeTools: ["tool_a", "tool_b"], allTools, cwd: CWD });
  const byKey = rowMap(rows);
  const keyA = "tools:user:top-level:$CWD/ext/tool.ts";
  const keyB = "tools:project:package:$CWD/ext/tool.ts";
  assert.ok(byKey.has(keyA));
  assert.ok(byKey.has(keyB));
  assert.equal(byKey.get(keyA)!.label, "Tools: user/top-level/$CWD/ext/tool.ts");
  assert.equal(byKey.get(keyB)!.label, "Tools: project/package/$CWD/ext/tool.ts");
  assert.equal(byKey.get(keyA)!.itemCount.value, 1);
  assert.equal(byKey.get(keyB)!.itemCount.value, 1);
});

test("prefixed dynamic labels and keys never exceed 120 characters", () => {
  const longName = "x".repeat(200);
  const longToolPath = "/Users/alice/project/" + longName;
  const allTools = [
    { name: "long_tool", description: "d", parameters: { type: "object" }, sourceInfo: { path: longToolPath, source: "local", scope: "user", origin: "top-level" } },
  ] as ToolInfo[];
  const messages = [
    { role: "user", content: "prompt text", timestamp: 1 },
    { role: "custom", customType: longName, content: "payload", display: true, timestamp: 2 },
  ] as unknown as AgentMessage[];
  const skillReads = new Map([["call-long", longName]]);
  const rows = attributeContext({
    system: emptySystem(),
    messages,
    promptSource: { kind: "skill", name: longName },
    skillReads,
    activeTools: ["long_tool"],
    allTools,
    cwd: CWD,
  });
  assert.equal(rows.length > 0, true);
  for (const row of rows) {
    assert.ok(row.label.length <= 120, `label exceeds 120: ${row.label.length}`);
    assert.ok(row.key.length <= 120, `key exceeds 120: ${row.key.length}`);
  }
});

test("system, cwd, snippet, and guideline markers never appear in returned rows", () => {
  const markers = { system: "MARKER_SYS_77aa", cwd: "MARKER_CWD_97b2", snippet: "MARKER_SNIPPET_75ff", guideline: "MARKER_GUIDELINE_86a1" };
  const markerCwd = `/Users/alice/project/${markers.cwd}`;
  const options = {
    cwd: markerCwd,
    toolSnippets: { read: `Snippet with ${markers.snippet}.`, bash: "Bash snippet." },
    promptGuidelines: [`Guideline with ${markers.guideline}.`],
    selectedTools: ["read", "bash"],
  };
  const prompt = buildPromptFixture(options) + `\n${markers.system}`;
  const rows = attributeContext({ system: { systemPrompt: prompt, options, matchesCurrent: true }, messages: [], activeTools: [], allTools: [] });
  const serialized = JSON.stringify(rows);
  for (const marker of Object.values(markers)) {
    assert.ok(!serialized.includes(marker), `returned rows leaked ${marker}`);
  }
  assert.equal(rows.some((r) => r.key === "system:cwd"), true);
});

test("preserves skill-prompt attribution through tool-loop requests with a keyed prompt digest", () => {
  const skillPrompt = "build the project now";
  const digestKey = "runtime-only-test-key";
  const currentPromptDigest = createHmac("sha256", digestKey).update(skillPrompt).digest("hex");
  const assistant = (id: string, toolName: string, args: Record<string, unknown>, ts: number) => ({
    role: "assistant",
    content: [{ type: "toolCall", id, name: toolName, arguments: args }],
    api: "openai", provider: "openai", model: "gpt-test",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse", timestamp: ts,
  });
  const toolResult = (id: string, text: string, ts: number) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: ts });
  const messages = [
    { role: "user", content: [{ type: "text", text: skillPrompt }], timestamp: 1 },
    assistant("call-1", "read", { path: "/src/main.ts" }, 2),
    toolResult("call-1", "File contents.", 3),
    // A second tool-loop turn appends another assistant response and result
    // without a new user message.
    assistant("call-2", "bash", { command: "ls" }, 4),
    toolResult("call-2", "src\n", 5),
  ] as unknown as AgentMessage[];
  const rows = attributeContext({
    system: emptySystem(),
    messages,
    promptSource: { kind: "skill", name: "build" },
    currentPromptDigest,
    digestKey,
    activeTools: [],
    allTools: [],
  });
  const byKey = rowMap(rows);
  assert.ok(byKey.has("msg:skill-prompt"), "the skill prompt must stay attributed in a tool loop");
  assert.equal(byKey.get("msg:skill-prompt")!.label, "Skill: build");
  assert.equal(byKey.get("msg:skill-prompt")!.characters.value, skillPrompt.length);
  assert.ok(!byKey.has("msg:user"), "the skill prompt must not fall into user history");
  assert.equal(byKey.get("msg:tool-call")!.itemCount.value, 2);
  assert.equal(byKey.get("msg:tool-result")!.itemCount.value, 2);
});

test("a repeated prompt digest resolves to the current match, not an older match", () => {
  const promptText = "build the project now";
  const digestKey = "runtime-only-test-key";
  const currentPromptDigest = createHmac("sha256", digestKey).update(promptText).digest("hex");
  const messages = [
    { role: "user", content: promptText, timestamp: 1 },
    { role: "user", content: promptText, timestamp: 2 },
  ] as unknown as AgentMessage[];
  const rows = attributeContext({
    system: emptySystem(),
    messages,
    promptSource: { kind: "skill", name: "build" },
    currentPromptDigest,
    digestKey,
    activeTools: [],
    allTools: [],
  });
  const byKey = rowMap(rows);
  assert.ok(byKey.has("msg:skill-prompt"), "the current repeated prompt must stay attributed as the skill prompt");
  assert.equal(byKey.get("msg:skill-prompt")!.label, "Skill: build");
  assert.equal(byKey.get("msg:skill-prompt")!.characters.value, promptText.length);
  assert.equal(byKey.get("msg:skill-prompt")!.itemCount.value, 1);
  assert.ok(byKey.has("msg:user"), "the older identical prompt must stay plain user history");
  assert.equal(byKey.get("msg:user")!.characters.value, promptText.length);
  assert.ok(!byKey.has("msg:user-unattributed"), "no user message may be mislabeled after the current prompt");
});

test("preserves prompt-template attribution through tool-loop requests", () => {
  const promptText = "design the module";
  const digestKey = "runtime-only-test-key";
  const currentPromptDigest = createHmac("sha256", digestKey).update(promptText).digest("hex");
  const messages = [
    { role: "user", content: promptText, timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/src/mod.ts" } }],
      api: "openai", provider: "openai", model: "gpt-test",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse", timestamp: 2,
    },
    { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "contents" }], isError: false, timestamp: 3 },
  ] as unknown as AgentMessage[];
  const rows = attributeContext({
    system: emptySystem(),
    messages,
    promptSource: { kind: "prompt", name: "interactive-plan" },
    currentPromptDigest,
    digestKey,
    activeTools: [],
    allTools: [],
  });
  const byKey = rowMap(rows);
  assert.ok(byKey.has("msg:prompt-template"), "the prompt template must stay attributed in a tool loop");
  assert.equal(byKey.get("msg:prompt-template")!.label, "Prompt template: interactive-plan");
  assert.equal(byKey.get("msg:prompt-template")!.characters.value, promptText.length);
});

test("a prompt digest that matches no user message never claims skill ownership", () => {
  const digestKey = "runtime-only-test-key";
  const currentPromptDigest = createHmac("sha256", digestKey).update("some other prompt text").digest("hex");
  const messages = [
    { role: "user", content: "build the project now", timestamp: 1 },
    { role: "user", content: "extension text", timestamp: 2 },
  ] as unknown as AgentMessage[];
  const rows = attributeContext({
    system: emptySystem(),
    messages,
    promptSource: { kind: "skill", name: "build" },
    currentPromptDigest,
    digestKey,
    activeTools: [],
    allTools: [],
  });
  const byKey = rowMap(rows);
  assert.ok(!byKey.has("msg:skill-prompt"), "no digest match must not claim a skill prompt");
  assert.ok(byKey.has("msg:user"), "the messages remain plain user history");
});

test("core-inserted guidelines cannot be claimed by the supplied guideline row", () => {
  const bashGuideline = "Use bash for file operations like ls, rg, find";
  const options = {
    cwd: CWD,
    selectedTools: ["read", "bash"],
    toolSnippets: { read: "Read a file from disk.", bash: "Run a shell command." },
    promptGuidelines: [bashGuideline],
  };
  const prompt = buildPromptFixture(options);
  const rows = attributeContext({ system: { systemPrompt: prompt, options, matchesCurrent: true }, messages: [], activeTools: [], allTools: [] });
  const byKey = rowMap(rows);
  assert.ok(!byKey.has("system:guidelines"), "a core-inserted Bash guideline must stay unclaimed");
  const remainder = byKey.get("system:remainder")!;
  assert.ok(remainder.characters.value! >= bashGuideline.length, "the core guideline remains in the unattributed remainder");
});

test("a supplied always-included guideline owns its span in Pi's insertion order", () => {
  const supplied = "Be concise in your responses";
  const options = { cwd: CWD, selectedTools: ["read"], promptGuidelines: [supplied] };
  const prompt = buildPromptFixture(options);
  const rows = attributeContext({ system: { systemPrompt: prompt, options, matchesCurrent: true }, messages: [], activeTools: [], allTools: [] });
  const byKey = rowMap(rows);
  const guidelines = byKey.get("system:guidelines");
  assert.ok(guidelines, "a supplied always-included guideline must be claimed");
  assert.equal(guidelines!.characters.value, supplied.length);
  assert.equal(guidelines!.itemCount.value, 1);
  const claimed = rows.filter((row) => row.key !== "system:remainder").reduce((sum, row) => sum + (row.characters.value ?? 0), 0);
  const remainder = byKey.get("system:remainder")!;
  assert.equal(remainder.characters.value, prompt.length - claimed);
  assert.ok(remainder.characters.value! < prompt.length - supplied.length, "the supplied span must not sit in the remainder");
});

test("the facade uses the public skill formatter export from the pi package", () => {
  assert.equal(
    formatSkillsForPrompt,
    publicFormatSkillsForPrompt,
    "attribution.ts must use the public formatSkillsForPrompt export instead of a local copy",
  );
});

test("matches a keyed skill-path digest and rejects mismatched paths", () => {
  const key = "runtime-only-test-key";
  const path = "/skills/commit/SKILL.md";
  const digest = keyedDigest(path, key);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(keyedDigest(path, key), digest);
  assert.notEqual(keyedDigest(path, key + "-other"), digest);
  const matches = new Map([[digest, "commit"]]);
  assert.equal(matchSkillPathDigest(path, key, matches), "commit");
  assert.equal(matchSkillPathDigest("/other/file.md", key, matches), undefined);
  assert.equal(matchSkillPathDigest(path, undefined, matches), undefined);
  assert.equal(matchSkillPathDigest(path, key, undefined), undefined);
});

test("precomputed system rows replace span claiming when provided", () => {
  const options = {
    cwd: CWD,
    contextFiles: [{ path: "AGENTS.md", content: "FILE_CONTENT_MARKER_11" }],
    appendSystemPrompt: "APPEND_MARKER_22",
  };
  const prompt = buildPromptFixture(options);
  const direct = attributeContext({ system: { systemPrompt: prompt, options, matchesCurrent: true }, messages: [], activeTools: [], allTools: [] });
  const precomputed = attributeContext({
    system: { systemPrompt: prompt, options: { cwd: CWD }, matchesCurrent: true },
    precomputedSystemRows: direct,
    messages: [],
    activeTools: [],
    allTools: [],
  });
  assert.deepEqual(precomputed, direct);
  assert.equal(precomputed.some((row) => row.key === "system:instruction:0"), true);
});

