import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { attributeContext } from "./attribution.ts";
import { createAttributionLedger, type AttributionLedger } from "./ledger.ts";
import { renderReport, ScrollableReportView, showContextAttribution, type AttributionReport } from "./render.ts";
import type {
  Attribution,
  LabeledValue,
  ProviderUsageRecord,
  RequestAttribution,
  RuntimeAggregate,
  SafeModelRecord,
  SourceEstimate,
} from "./types.ts";

const SAFE_MODEL: SafeModelRecord = {
  provider: "openai-codex",
  api: "openai-responses",
  model: "gpt-5.6-sol",
  measurement: "recorded",
};

function sourceRow(
  key: string,
  label: string,
  characters: number,
  tokens?: number,
  attribution: Attribution = "attributed",
): SourceEstimate {
  return {
    key,
    category: "system",
    label,
    attribution,
    characters: { value: characters, measurement: "recorded" },
    tokens: { value: tokens ?? Math.ceil(characters / 4), measurement: "estimated" },
    itemCount: { value: 1, measurement: "recorded" },
  };
}

function usageRecord(fields: Partial<Record<keyof ProviderUsageRecord, number>> = {}): ProviderUsageRecord {
  const record = {} as Record<keyof ProviderUsageRecord, LabeledValue>;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "totalTokens"] as const) {
    const value = fields[key];
    record[key] =
      value === undefined
        ? { value: null, measurement: "unavailable" }
        : { value, measurement: "provider-reported" };
  }
  return record as ProviderUsageRecord;
}

function request(overrides: Partial<RequestAttribution> = {}): RequestAttribution {
  return {
    sequence: 7,
    turnIndex: null,
    status: "complete",
    correlation: "recorded",
    providerRequest: "recorded",
    model: SAFE_MODEL,
    sources: [],
    providerUsage: null,
    warnings: [],
    ...overrides,
  };
}

function aggregate(overrides: Partial<RuntimeAggregate> = {}): RuntimeAggregate {
  return {
    eligibleRequests: 0,
    completeProviderUsage: 0,
    providerUsageTotals: usageRecord(),
    estimatedCharacters: {},
    excludedProviderCalls: 0,
    correlationFailures: 0,
    ...overrides,
  };
}

function report(overrides: Partial<AttributionReport> = {}): AttributionReport {
  return {
    latest: null,
    providerAttempts: null,
    aggregate: aggregate(),
    ...overrides,
  };
}

/** Formatting contract mirrors: "  " + label.padEnd(14) + " " + value.padStart(11). */
function usageLine(label: string, value: string): string {
  return `  ${label.padEnd(14)} ${value.padStart(11)}`;
}

/** Formatting contract mirrors: "  " + label.padEnd(24) + " " + chars + "  " + tokens + suffix. */
function sourceLine(label: string, chars: string, tokens: string, unattributed = false): string {
  return `  ${label.padEnd(24)} ${chars}  ${tokens}${unattributed ? " [unattributed]" : ""}`;
}

function startRun(ledger: AttributionLedger): void {
  ledger.observeSessionStart("startup");
  ledger.observeInput("interactive");
  ledger.observeAgentStart();
}

function assistantMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    usage: { input: 100, output: 40, cacheRead: 500, cacheWrite: 0, totalTokens: 640 },
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  };
}

test("renders an empty ledger with unavailable scope and usage", () => {
  const text = renderReport(report());
  assert.equal(
    text,
    [
      "Context attribution — no recorded request",
      "Scope: unavailable",
      "",
      "Provider usage [unavailable]",
      usageLine("input", "unavailable"),
      usageLine("cache read", "unavailable"),
      usageLine("cache write", "unavailable"),
      usageLine("cache write 1h", "unavailable"),
      usageLine("output", "unavailable"),
      usageLine("reasoning", "unavailable"),
      usageLine("total", "unavailable"),
      "",
      "Context sources",
      "",
      "Runtime aggregate [recorded]",
      "  Eligible requests: 0",
      "  Complete provider usage: 0",
      "  Provider usage totals [unavailable]",
      "    " + usageLine("input", "unavailable").trimStart(),
      "    " + usageLine("cache read", "unavailable").trimStart(),
      "    " + usageLine("cache write", "unavailable").trimStart(),
      "    " + usageLine("cache write 1h", "unavailable").trimStart(),
      "    " + usageLine("output", "unavailable").trimStart(),
      "    " + usageLine("reasoning", "unavailable").trimStart(),
      "    " + usageLine("total", "unavailable").trimStart(),
      "  Excluded provider calls: 0",
      "  Correlation failures: 0",
      "  Estimated characters: 0",
      "",
      "Exact per-source provider tokens: unavailable",
      "Later context transforms after this hook: unavailable",
      "No raw prompt, result, or provider payload data was retained.",
    ].join("\n"),
  );
  assert.ok(!text.includes("foreground normal request"));
});

test("renders a pending request without provider usage", () => {
  const text = renderReport(
    report({
      latest: request({
        status: "pending",
        providerUsage: null,
        providerRequest: "unavailable",
        sources: [sourceRow("system:remainder", "System remainder", 2_100, 525, "unattributed")],
      }),
      providerAttempts: 0,
      aggregate: aggregate({ eligibleRequests: 1, estimatedCharacters: { "system:remainder": 2_100 } }),
    }),
  );
  assert.ok(text.includes("Context attribution — latest foreground request #7"));
  assert.ok(text.includes("Scope: foreground pending request [recorded]"));
  assert.ok(text.includes("Provider usage [unavailable]"));
  assert.ok(!text.includes("Provider attempts:"));
  assert.ok(text.includes("Exact per-source provider tokens: unavailable"));
});

test("renders complete, error, and aborted requests with the approved scope labels", () => {
  const cases: Array<{ status: RequestAttribution["status"]; scope: string }> = [
    { status: "complete", scope: "foreground normal request [recorded]" },
    { status: "error", scope: "foreground error request [recorded]" },
    { status: "aborted", scope: "foreground aborted request [recorded]" },
    { status: "unavailable", scope: "foreground request [unavailable]" },
  ];
  for (const entry of cases) {
    const text = renderReport(report({ latest: request({ status: entry.status }) }));
    assert.ok(text.includes(`Scope: ${entry.scope}`), entry.status);
  }
});

test("renders the mandatory example structure", () => {
  const text = renderReport(
    report({
      latest: request({
        providerUsage: usageRecord({ input: 1_240, totalTokens: 55_660 }),
        sources: [
          sourceRow("system:agents", "AGENTS.md", 22_738, 5_685),
          sourceRow("system:remainder", "System remainder", 2_100, 525, "unattributed"),
        ],
      }),
      providerAttempts: 1,
      aggregate: aggregate({
        eligibleRequests: 1,
        completeProviderUsage: 1,
        providerUsageTotals: usageRecord({ input: 1_240, totalTokens: 55_660 }),
        estimatedCharacters: { "system:agents": 22_738, "system:remainder": 2_100 },
      }),
    }),
  );
  assert.ok(text.includes("Context attribution — latest foreground request #7"));
  assert.ok(text.includes("Scope: foreground normal request [recorded]"));
  assert.ok(text.includes("Model: openai-codex / openai-responses / gpt-5.6-sol [recorded]"));
  assert.ok(text.includes("Provider usage [provider-reported]"));
  assert.ok(text.includes(usageLine("input", "1,240")));
  assert.ok(text.includes(usageLine("total", "55,660")));
  assert.ok(text.includes("Context sources"));
  assert.ok(text.includes(sourceLine("AGENTS.md", "22,738 chars [recorded]", "~5,685 tokens [estimated]")));
  assert.ok(
    text.includes(sourceLine("System remainder", "2,100 chars [recorded]", "~525 tokens [estimated]", true)),
  );
  assert.ok(text.includes("Exact per-source provider tokens: unavailable"));
  assert.ok(!text.includes("Provider attempts:"));
});

test("renders partial provider usage and preserves recorded zeros", () => {
  const text = renderReport(
    report({
      latest: request({
        providerUsage: usageRecord({ input: 5, output: 3, cacheWrite: 0, totalTokens: 0 }),
      }),
    }),
  );
  assert.ok(text.includes(usageLine("input", "5")));
  assert.ok(text.includes(usageLine("output", "3")));
  assert.ok(text.includes(usageLine("cache write", "0")));
  assert.ok(text.includes(usageLine("cache read", "unavailable")));
  assert.ok(text.includes(usageLine("cache write 1h", "unavailable")));
  assert.ok(text.includes(usageLine("reasoning", "unavailable")));
  assert.ok(text.includes(usageLine("total", "0")));
  assert.ok(!text.includes(usageLine("cache read", "0")));
});

test("sorts source rows by estimated tokens then stable key", () => {
  const rows = [
    sourceRow("z:small", "Small", 400, 100),
    sourceRow("a:agents", "AGENTS.md", 22_738, 5_685),
    sourceRow("m:remainder", "Remainder", 2_100, 525),
    sourceRow("k:alpha", "Alpha", 400, 100),
  ];
  const text = renderReport(report({ latest: request({ sources: rows }) }));
  const sourceIndex = text.indexOf("Context sources");
  const section = text.slice(sourceIndex, text.indexOf("Runtime aggregate"));
  const small = section.indexOf("Small");
  const agents = section.indexOf("AGENTS.md");
  const remainder = section.indexOf("Remainder");
  const alpha = section.indexOf("Alpha");
  assert.ok(agents < remainder && remainder < alpha && alpha < small);
});

test("renders the attribution-produced composed source labels unchanged", () => {
  const rows = [
    sourceRow("tools:pi built-in", "Tools: pi built-in", 40_000),
    sourceRow("tools:pi sdk", "Tools: pi sdk", 500),
    sourceRow("msg:skill-prompt", "Skill: build", 20_200),
    sourceRow("msg:prompt-template", "Prompt template: interactive-plan", 1_200),
    sourceRow("msg:skill-read:commit", "Skill body: commit", 600),
    sourceRow("msg:custom:example-extension", "Extension: example-extension", 800),
    sourceRow(
      "tools:project:package:git/github.com/nicobailon/pi-mcp-adapter",
      "Tools: project/package/git/github.com/nicobailon/pi-mcp-adapter",
      700,
    ),
  ];
  const text = renderReport(report({ latest: request({ sources: rows }) }));
  const expected = [
    "Tools: pi built-in",
    "Tools: pi sdk",
    "Skill: build",
    "Prompt template: interactive-plan",
    "Skill body: commit",
    "Extension: example-extension",
    "Tools: project/package/git/github.com/nicobailon/pi-mcp-adapter",
  ];
  for (const label of expected) {
    assert.ok(text.includes(label), `composed source label lost: ${label}`);
  }
});

test("the display guard strips controls, caps length, and keeps composed labels", () => {
  const text = renderReport(
    report({
      latest: request({
        sources: [
          sourceRow("k:ctrl", "Skill:\u0000evil", 100),
          sourceRow("k:long", `Tools: ${"x".repeat(300)}`, 200),
        ],
      }),
    }),
  );
  assert.ok(!text.includes("\u0000"), "control character leaked");
  assert.ok(text.includes("Skill: evil"), "control-stripped label was lost");
  assert.ok(text.includes("…"), "overlong label was not capped");
  assert.ok(!text.includes("x".repeat(113)), "overlong label exceeded the length cap");
});

test("formats numbers with thousands separators", () => {
  const text = renderReport(
    report({
      latest: request({ providerUsage: usageRecord({ input: 1_808_087_896, totalTokens: 1_947_755_668 }) }),
    }),
  );
  assert.ok(text.includes(usageLine("input", "1,808,087,896")));
  assert.ok(text.includes(usageLine("total", "1,947,755,668")));
});

test("renders the recorded runtime aggregate with counts and partial field sums", () => {
  const text = renderReport(
    report({
      latest: request(),
      providerAttempts: null,
      aggregate: aggregate({
        eligibleRequests: 12,
        completeProviderUsage: 11,
        providerUsageTotals: usageRecord({ input: 3_240, cacheRead: 3_000 }),
        estimatedCharacters: { "system:remainder": 100, "msg:user": 200 },
        excludedProviderCalls: 3,
        correlationFailures: 2,
      }),
    }),
  );
  assert.ok(text.includes("Runtime aggregate [recorded]"));
  assert.ok(text.includes("  Eligible requests: 12"));
  assert.ok(text.includes("  Complete provider usage: 11"));
  assert.ok(text.includes("  Excluded provider calls: 3"));
  assert.ok(text.includes("  Correlation failures: 2"));
  assert.ok(text.includes("  Estimated characters: 300"));
  assert.ok(text.includes("  Provider usage totals [provider-reported]"));
  assert.ok(text.includes("    " + usageLine("input", "3,240").trimStart()));
  assert.ok(text.includes("    " + usageLine("cache read", "3,000").trimStart()));
  assert.ok(text.includes("    " + usageLine("output", "unavailable").trimStart()));
});

test("renders fixed warnings for hook order, system mismatch, and correlation failure", () => {
  const text = renderReport(
    report({
      latest: request({
        warnings: ["ambiguous-context-order", "system-digest-mismatch", "correlation-unavailable"],
      }),
    }),
  );
  assert.ok(text.includes("Warnings"));
  assert.ok(text.includes("  - Context events arrived in an ambiguous order; correlation is unavailable."));
  assert.ok(
    text.includes("  - The system prompt changed after capture; detailed system attribution is unavailable."),
  );
  assert.ok(text.includes("  - The request could not be correlated with a provider response."));
});

test("shows provider attempts only when a retry occurred", () => {
  const ledger = createAttributionLedger();
  startRun(ledger);
  ledger.observeContext([sourceRow("system:remainder", "Remainder", 400)]);
  ledger.observeProviderRequest(SAFE_MODEL);
  ledger.observeProviderRequest(SAFE_MODEL);
  ledger.observeProviderRequest(SAFE_MODEL);
  ledger.observeMessageEnd(assistantMessage());
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.providerAttempts, 3);
  const retryText = renderReport(snapshot);
  assert.ok(retryText.includes("Provider attempts: 3 [recorded]"));

  const normal = createAttributionLedger();
  startRun(normal);
  normal.observeContext([sourceRow("system:remainder", "Remainder", 400)]);
  normal.observeProviderRequest(SAFE_MODEL);
  normal.observeMessageEnd(assistantMessage());
  const normalText = renderReport(normal.snapshot());
  assert.ok(!normalText.includes("Provider attempts:"));
});

test("keeps secret markers out of every rendered dynamic value", () => {
  // Raw unsafe values pass through the attribution boundary first. The
  // boundary sanitizes each dynamic part; the renderer never sees the raw
  // strings. The model record is the one raw shape the renderer sanitizes.
  const sources = attributeContext({
    system: { systemPrompt: "synthetic system prompt", options: { cwd: "/tmp" }, matchesCurrent: true },
    messages: [
      {
        role: "custom",
        customType: "https://user:pass@example.test/custom?q=MARKER_CUSTOM#frag",
        content: [{ type: "text", text: "Custom extension content." }],
        timestamp: 1,
      },
      { role: "user", content: "/Users/alice/private/MARKER_DIR/file.ts", timestamp: 2 },
    ],
    promptSource: undefined,
    activeTools: [],
    allTools: [],
  });
  const text = renderReport(
    report({
      latest: request({
        model: {
          provider: "https://user:pass@example.test/provider?q=MARKER_MODEL_1#frag",
          api: "/Users/alice/private/MARKER_DIR/api",
          model: "gpt-5.6-sol",
          measurement: "recorded",
        },
        sources,
      }),
      aggregate: aggregate({ estimatedCharacters: { "KEY_AGG_1": 100, "KEY_AGG_2": 200 } }),
    }),
  );
  for (const marker of ["KEY_AGG_1", "KEY_AGG_2", "MARKER_MODEL_1", "MARKER_CUSTOM", "MARKER_QUERY", "MARKER_DIR"]) {
    assert.ok(!text.includes(marker), `rendered report leaked ${marker}`);
  }
  assert.ok(!text.includes("user:pass"));
  assert.ok(!text.includes("#frag"));
  assert.ok(!text.includes("/Users/alice"));
  assert.ok(!text.includes("alice"));
});

test("a sentinel raw value never reaches the rendered output", () => {
  const ledger = createAttributionLedger();
  startRun(ledger);
  ledger.observeContext([sourceRow("system:remainder", "Remainder", 400)]);
  ledger.observeProviderRequest(SAFE_MODEL);
  ledger.observeMessageEnd(
    assistantMessage({
      responseId: "MARKER_RESPONSE_77",
      errorMessage: "MARKER_ERROR_88",
      content: [{ type: "text", text: "MARKER_CONTENT_99" }],
    }),
  );
  const text = renderReport(ledger.snapshot());
  for (const marker of ["MARKER_RESPONSE_77", "MARKER_ERROR_88", "MARKER_CONTENT_99"]) {
    assert.ok(!text.includes(marker), `rendered report leaked ${marker}`);
  }
});

test("the scroll view truncates lines to a narrow width", () => {
  const view = new ScrollableReportView("first line\nsecond line\nthird line");
  const rendered = view.render(6, 3);
  assert.equal(rendered.length, 3);
  for (const line of rendered) {
    assert.ok(visibleWidth(line) <= 6, `line too wide: ${line}`);
  }
});

test("the scroll view clamps scroll bounds and pages by view height", () => {
  const view = new ScrollableReportView(Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n"));
  view.render(80, 3);
  for (let i = 0; i < 20; i += 1) view.handleInput("\u001b[B");
  assert.equal(view.scrollOffset, 7);
  let rendered = view.render(80, 3);
  assert.deepEqual(rendered, ["line 8", "line 9", "line 10"]);
  for (let i = 0; i < 20; i += 1) view.handleInput("\u001b[A");
  assert.equal(view.scrollOffset, 0);
  rendered = view.render(80, 3);
  assert.deepEqual(rendered, ["line 1", "line 2", "line 3"]);
  view.handleInput("\u001b[6~");
  assert.equal(view.scrollOffset, 3);
  view.handleInput("\u001b[5~");
  assert.equal(view.scrollOffset, 0);
});

test("the scroll view closes once on Enter or Escape", () => {
  let closes = 0;
  const view = new ScrollableReportView("one\ntwo\nthree", () => {
    closes += 1;
  });
  view.handleInput("\r");
  view.handleInput("\r");
  assert.equal(closes, 1);
  assert.equal(view.isClosed, true);

  let escapeCloses = 0;
  const other = new ScrollableReportView("one", () => {
    escapeCloses += 1;
  });
  other.handleInput("\u001b");
  assert.equal(escapeCloses, 1);
  assert.equal(other.isClosed, true);
  other.handleInput("\u001b[A");
  assert.equal(other.scrollOffset, 0);
});

test("showContextAttribution prints the same report in non-TUI modes without touching the UI", async () => {
  for (const mode of ["print", "rpc", "json"]) {
    const ui = new Proxy(
      {},
      {
        get() {
          throw new Error("non-TUI mode must not touch the UI");
        },
      },
    );
    const ctx = { mode, ui } as unknown as ExtensionContext;
    const rpt = report({
      latest: request({ sources: [sourceRow("system:remainder", "Remainder", 400)] }),
      providerAttempts: null,
      aggregate: aggregate({ eligibleRequests: 1 }),
    });
    const logged: string[] = [];
    const original = console.log;
    console.log = (message?: unknown) => {
      logged.push(String(message));
    };
    try {
      await showContextAttribution(rpt, ctx);
    } finally {
      console.log = original;
    }
    assert.equal(logged.length, 1, mode);
    assert.equal(logged[0], renderReport(rpt), mode);
  }
});

test("showContextAttribution shows a scrollable overlay only in TUI mode and adds no session content", async () => {
  let capturedFactory: ((tui: unknown, theme: unknown, keybindings: unknown, done: () => void) => unknown) | undefined;
  let capturedOptions: unknown;
  const ui = {
    custom: async (factory: unknown, options: unknown) => {
      capturedFactory = factory as typeof capturedFactory;
      capturedOptions = options;
      return undefined;
    },
  };
  const ctx = { mode: "tui", ui } as unknown as ExtensionContext;
  const rpt = report({ latest: request() });
  const logged: string[] = [];
  const original = console.log;
  console.log = (message?: unknown) => {
    logged.push(String(message));
  };
  try {
    await showContextAttribution(rpt, ctx);
  } finally {
    console.log = original;
  }
  assert.equal(logged.length, 0, "TUI mode must not print");
  assert.ok(capturedFactory, "TUI mode must open a custom overlay");
  assert.deepEqual(capturedOptions, { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" } });

  let doneCalls = 0;
  const component = capturedFactory!({ terminal: { rows: 40 } }, {}, {}, () => {
    doneCalls += 1;
  }) as { render(width: number): string[]; handleInput(data: string): void; invalidate(): void };
  const rendered = component.render(80);
  assert.ok(Array.isArray(rendered));
  for (const line of rendered) {
    assert.ok(visibleWidth(line) <= 80);
  }
  component.invalidate();
  component.handleInput("\u001b");
  assert.equal(doneCalls, 1);
});

test("a small terminal reaches every report line within the overlay height", async () => {
  const rpt = report({
    latest: request({
      warnings: ["correlation-unavailable"],
      sources: [sourceRow("system:remainder", "Remainder", 400)],
    }),
    providerAttempts: null,
    aggregate: aggregate({ eligibleRequests: 1, estimatedCharacters: { "system:remainder": 400 } }),
  });
  const text = renderReport(rpt);
  const lastLine = text.split("\n").at(-1)!;
  for (const rows of [10, 12, 13]) {
    let capturedFactory: ((tui: unknown, theme: unknown, keybindings: unknown, done: () => void) => unknown) | undefined;
    const ui = {
      custom: async (factory: unknown) => {
        capturedFactory = factory as typeof capturedFactory;
        return undefined;
      },
    };
    await showContextAttribution(rpt, { mode: "tui", ui } as unknown as ExtensionContext);
    const overlayMaxHeight = Math.max(1, Math.floor(rows * 0.8));
    const component = capturedFactory!({ terminal: { rows } }, {}, {}, () => {}) as {
      render(width: number): string[];
      handleInput(data: string): void;
    };
    // The component height must match the overlay maxHeight. A taller
    // component would lose its bottom lines to the overlay slice.
    assert.equal(component.render(80).length, overlayMaxHeight, `rows=${rows} height mismatch`);
    // Scrolling to the bottom must reveal the last report line.
    for (let i = 0; i < 300; i += 1) component.handleInput("\u001b[B");
    const bottom = component.render(80);
    assert.ok(bottom.includes(lastLine), `rows=${rows}: the last report line is unreachable`);
  }
});

test("the overlay height adapts after a terminal resize", async () => {
  const rpt = report({
    latest: request({
      warnings: ["correlation-unavailable"],
      sources: [sourceRow("system:remainder", "Remainder", 400)],
    }),
    providerAttempts: null,
    aggregate: aggregate({ eligibleRequests: 1, estimatedCharacters: { "system:remainder": 400 } }),
  });
  const text = renderReport(rpt);
  const lastLine = text.split("\n").at(-1)!;
  let capturedFactory: ((tui: unknown, theme: unknown, keybindings: unknown, done: () => void) => unknown) | undefined;
  const ui = {
    custom: async (factory: unknown) => {
      capturedFactory = factory as typeof capturedFactory;
      return undefined;
    },
  };
  await showContextAttribution(rpt, { mode: "tui", ui } as unknown as ExtensionContext);
  const tui = { terminal: { rows: 30 } };
  const component = capturedFactory!(tui, {}, {}, () => {}) as {
    render(width: number): string[];
    handleInput(data: string): void;
  };
  assert.equal(component.render(80).length, Math.floor(30 * 0.8));
  tui.terminal.rows = 12; // the terminal resizes while the overlay stays open
  assert.equal(component.render(80).length, Math.floor(12 * 0.8), "rows=12 height mismatch after resize");
  for (let i = 0; i < 300; i += 1) component.handleInput("\u001b[B");
  const bottom = component.render(80);
  assert.ok(bottom.includes(lastLine), "the last report line is unreachable after a resize");
});

