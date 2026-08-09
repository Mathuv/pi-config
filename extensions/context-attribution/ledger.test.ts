import assert from "node:assert/strict";
import { test } from "node:test";
import { createAttributionLedger, type AttributionLedger } from "./ledger.ts";
import type { SafeModelRecord, SourceEstimate } from "./types.ts";

const SAFE_MODEL: SafeModelRecord = {
  provider: "openai-codex",
  api: "openai-responses",
  model: "gpt-5.6-sol",
  measurement: "recorded",
};

function sourceRow(key: string, characters: number): SourceEstimate {
  return {
    key,
    category: "system",
    label: "safe label",
    attribution: "attributed",
    characters: { value: characters, measurement: "recorded" },
    tokens: { value: Math.ceil(characters / 4), measurement: "estimated" },
    itemCount: { value: 1, measurement: "recorded" },
  };
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

function startRun(ledger: AttributionLedger, source = "interactive"): void {
  ledger.observeSessionStart("startup");
  ledger.observeInput(source);
  ledger.observeAgentStart();
}

function completeRequest(ledger: AttributionLedger, characters = 400, message: unknown = assistantMessage()): void {
  ledger.observeContext([sourceRow("system:remainder", characters)]);
  ledger.observeProviderRequest(SAFE_MODEL);
  ledger.observeMessageEnd(message);
}

test("a fresh ledger starts empty and reports a zeroed aggregate", () => {
  const ledger = createAttributionLedger();
  const report = ledger.snapshot();
  assert.equal(report.latest, null);
  assert.equal(report.aggregate.eligibleRequests, 0);
  assert.equal(report.aggregate.completeProviderUsage, 0);
  assert.equal(report.aggregate.excludedProviderCalls, 0);
  assert.equal(report.aggregate.correlationFailures, 0);
  assert.deepEqual(report.aggregate.providerUsageTotals.input, { value: null, measurement: "unavailable" });
  assert.deepEqual(report.aggregate.estimatedCharacters, {});
});

test("accepts interactive and RPC idle input as eligible foreground runs", () => {
  for (const source of ["interactive", "rpc"]) {
    const ledger = createAttributionLedger();
    startRun(ledger, source);
    completeRequest(ledger);
    const report = ledger.snapshot();
    assert.equal(report.latest?.status, "complete", source);
    assert.equal(report.latest?.correlation, "recorded", source);
    assert.equal(report.latest?.providerRequest, "recorded", source);
    assert.equal(report.latest?.sequence, 1, source);
    assert.equal(report.aggregate.eligibleRequests, 1, source);
  }
});

test("rejects idle extension input and suppresses one draft after an in-run extension input", () => {
  const idle = createAttributionLedger();
  startRun(idle, "extension");
  idle.observeContext([sourceRow("system:remainder", 100)]);
  idle.observeProviderRequest(SAFE_MODEL);
  idle.observeMessageEnd(assistantMessage());
  let report = idle.snapshot();
  assert.equal(report.latest, null);
  assert.equal(report.aggregate.eligibleRequests, 0);
  assert.equal(report.aggregate.excludedProviderCalls, 1);
  assert.equal(report.aggregate.correlationFailures, 0);

  const run = createAttributionLedger();
  startRun(run);
  completeRequest(run);
  run.observeInput("extension");
  run.observeContext([sourceRow("system:remainder", 200)]);
  run.observeProviderRequest(SAFE_MODEL);
  run.observeMessageEnd(assistantMessage());
  run.observeContext([sourceRow("system:remainder", 300)]);
  run.observeProviderRequest(SAFE_MODEL);
  run.observeMessageEnd(assistantMessage());
  report = run.snapshot();
  assert.equal(report.latest?.sequence, 2);
  assert.equal(report.latest?.status, "complete");
  assert.equal(report.latest?.correlation, "recorded");
  assert.equal(report.aggregate.eligibleRequests, 2);
  assert.equal(report.aggregate.excludedProviderCalls, 1);
  assert.equal(report.aggregate.correlationFailures, 0);
});

test("an interactive or RPC steer during a run does not change the run origin", () => {
  const ledger = createAttributionLedger();
  startRun(ledger);
  completeRequest(ledger);
  ledger.observeInput("rpc");
  completeRequest(ledger);
  const report = ledger.snapshot();
  assert.equal(report.aggregate.eligibleRequests, 2);
  assert.equal(report.latest?.sequence, 2);
  assert.equal(report.latest?.correlation, "recorded");
  assert.equal(report.aggregate.excludedProviderCalls, 0);
});

test("any PI_SUBAGENT_* environment key disables capture", () => {
  const env = { PI_SUBAGENT_CHILD_AGENT: "worker", PI_SUBAGENT_RUN_ID: "run-1" };
  const ledger = createAttributionLedger(env);
  startRun(ledger);
  ledger.observeContext([sourceRow("system:remainder", 100)]);
  ledger.observeProviderRequest(SAFE_MODEL);
  ledger.observeMessageEnd(assistantMessage());
  const report = ledger.snapshot();
  assert.equal(report.latest, null);
  assert.equal(report.aggregate.eligibleRequests, 0);
  assert.equal(report.aggregate.completeProviderUsage, 0);
  assert.equal(report.aggregate.excludedProviderCalls, 1);

  const other = createAttributionLedger({ PATH: "/usr/bin" });
  startRun(other);
  other.observeContext([sourceRow("system:remainder", 100)]);
  other.observeProviderRequest(SAFE_MODEL);
  other.observeMessageEnd(assistantMessage());
  assert.equal(other.snapshot().latest?.correlation, "recorded");
});

test("one normal request completes and duplicate provider calls stay on the same draft", () => {
  const ledger = createAttributionLedger();
  startRun(ledger);
  ledger.observeContext([sourceRow("system:remainder", 400)]);
  ledger.observeProviderRequest(SAFE_MODEL);
  ledger.observeProviderRequest(SAFE_MODEL);
  ledger.observeMessageEnd(assistantMessage());
  const report = ledger.snapshot();
  assert.equal(report.latest?.status, "complete");
  assert.equal(report.latest?.sequence, 1);
  assert.equal(report.latest?.correlation, "recorded");
  assert.equal(report.latest?.providerRequest, "recorded");
  assert.equal(report.aggregate.eligibleRequests, 1);
  assert.equal(report.aggregate.completeProviderUsage, 1);
  assert.deepEqual(report.latest?.providerUsage?.input, { value: 100, measurement: "provider-reported" });
  assert.deepEqual(report.latest?.providerUsage?.totalTokens, { value: 640, measurement: "provider-reported" });
});

test("a two-request tool loop creates one request per cycle", () => {
  const ledger = createAttributionLedger();
  startRun(ledger);
  ledger.observeContext([sourceRow("system:remainder", 400)]);
  ledger.observeProviderRequest(SAFE_MODEL);
  ledger.observeMessageEnd(assistantMessage({ stopReason: "toolUse" }));
  ledger.observeContext([sourceRow("system:remainder", 300)]);
  ledger.observeProviderRequest(SAFE_MODEL);
  ledger.observeMessageEnd(assistantMessage());
  const report = ledger.snapshot();
  assert.equal(report.aggregate.eligibleRequests, 2);
  assert.equal(report.aggregate.completeProviderUsage, 2);
  assert.equal(report.latest?.sequence, 2);
  assert.equal(report.latest?.status, "complete");
  assert.equal(report.latest?.correlation, "recorded");
  assert.deepEqual(report.aggregate.providerUsageTotals.input, { value: 200, measurement: "provider-reported" });
  assert.deepEqual(report.aggregate.providerUsageTotals.cacheRead, { value: 1000, measurement: "provider-reported" });
});

test("a provider observation without a draft only increments the excluded counter", () => {
  const ledger = createAttributionLedger();
  ledger.observeSessionStart("startup");
  ledger.observeProviderRequest(SAFE_MODEL);
  let report = ledger.snapshot();
  assert.equal(report.aggregate.excludedProviderCalls, 1);
  assert.equal(report.latest, null);
  assert.equal(report.aggregate.eligibleRequests, 0);
  assert.equal(report.aggregate.correlationFailures, 0);

  ledger.observeInput("interactive");
  ledger.observeAgentStart();
  completeRequest(ledger);
  ledger.observeAgentSettled();
  ledger.observeProviderRequest(SAFE_MODEL);
  report = ledger.snapshot();
  assert.equal(report.aggregate.excludedProviderCalls, 2);
  assert.equal(report.aggregate.eligibleRequests, 1);
});

test("the ledger API accepts no provider payload parameter", () => {
  const ledger = createAttributionLedger();
  assert.equal(ledger.observeProviderRequest.length, 1);
  assert.equal(ledger.observeContext.length, 1);
  assert.equal(ledger.observeMessageEnd.length, 1);
});

test("ignores non-assistant message_end events", () => {
  const ledger = createAttributionLedger();
  startRun(ledger);
  ledger.observeContext([sourceRow("system:remainder", 400)]);
  ledger.observeMessageEnd({ role: "user", content: "text" });
  ledger.observeMessageEnd({ role: "toolResult", toolCallId: "c1" });
  ledger.observeMessageEnd({});
  ledger.observeMessageEnd(null);
  ledger.observeProviderRequest(SAFE_MODEL);
  ledger.observeMessageEnd(assistantMessage());
  const report = ledger.snapshot();
  assert.equal(report.latest?.status, "complete");
  assert.equal(report.latest?.correlation, "recorded");
  assert.equal(report.aggregate.completeProviderUsage, 1);
});

test("keeps missing provider usage unavailable with a fixed warning", () => {
  for (const usage of [undefined, null]) {
    const ledger = createAttributionLedger();
    startRun(ledger);
    ledger.observeContext([sourceRow("system:remainder", 400)]);
    ledger.observeProviderRequest(SAFE_MODEL);
    ledger.observeMessageEnd(assistantMessage({ usage }));
    const report = ledger.snapshot();
    assert.equal(report.latest?.status, "complete");
    assert.equal(report.latest?.providerUsage, null);
    assert.deepEqual(report.latest?.warnings, ["provider-usage-unavailable"]);
    assert.equal(report.aggregate.completeProviderUsage, 0);
  }
});

test("copies partial provider usage and marks missing fields unavailable", () => {
  const ledger = createAttributionLedger();
  startRun(ledger);
  ledger.observeContext([sourceRow("system:remainder", 400)]);
  ledger.observeProviderRequest(SAFE_MODEL);
  ledger.observeMessageEnd(assistantMessage({ usage: { input: 5, output: 3 } }));
  const report = ledger.snapshot();
  assert.deepEqual(report.latest?.providerUsage?.input, { value: 5, measurement: "provider-reported" });
  assert.deepEqual(report.latest?.providerUsage?.output, { value: 3, measurement: "provider-reported" });
  assert.deepEqual(report.latest?.providerUsage?.cacheRead, { value: null, measurement: "unavailable" });
  assert.deepEqual(report.latest?.providerUsage?.cacheWrite1h, { value: null, measurement: "unavailable" });
  assert.deepEqual(report.latest?.providerUsage?.reasoning, { value: null, measurement: "unavailable" });
  assert.deepEqual(report.latest?.providerUsage?.totalTokens, { value: null, measurement: "unavailable" });
  assert.equal(report.aggregate.completeProviderUsage, 1);
  assert.deepEqual(report.latest?.warnings, []);
});

test("preserves zero usage exactly and never recomputes totalTokens", () => {
  const ledger = createAttributionLedger();
  startRun(ledger);
  ledger.observeContext([sourceRow("system:remainder", 400)]);
  ledger.observeProviderRequest(SAFE_MODEL);
  ledger.observeMessageEnd(assistantMessage({ usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } }));
  const report = ledger.snapshot();
  assert.deepEqual(report.latest?.providerUsage?.input, { value: 1, measurement: "provider-reported" });
  assert.deepEqual(report.latest?.providerUsage?.output, { value: 1, measurement: "provider-reported" });
  assert.deepEqual(report.latest?.providerUsage?.cacheRead, { value: 0, measurement: "provider-reported" });
  assert.deepEqual(report.latest?.providerUsage?.cacheWrite, { value: 0, measurement: "provider-reported" });
  assert.deepEqual(report.latest?.providerUsage?.totalTokens, { value: 0, measurement: "provider-reported" });
  assert.equal(report.aggregate.completeProviderUsage, 1);
});

test("maps error, aborted, and complete stop reasons to request status", () => {
  const cases = [
    { stopReason: "error", status: "error" },
    { stopReason: "aborted", status: "aborted" },
    { stopReason: "stop", status: "complete" },
    { stopReason: "toolUse", status: "complete" },
    { stopReason: "length", status: "complete" },
  ];
  for (const entry of cases) {
    const ledger = createAttributionLedger();
    startRun(ledger);
    completeRequest(ledger, 400, assistantMessage({ stopReason: entry.stopReason }));
    assert.equal(ledger.snapshot().latest?.status, entry.status, entry.stopReason);
  }
});

test("two context events before finalization mark correlation unavailable", () => {
  const ledger = createAttributionLedger();
  startRun(ledger);
  ledger.observeContext([sourceRow("system:remainder", 100)]);
  ledger.observeContext([sourceRow("system:remainder", 200)]);
  ledger.observeProviderRequest(SAFE_MODEL);
  ledger.observeMessageEnd(assistantMessage());
  const report = ledger.snapshot();
  assert.equal(report.latest?.status, "complete");
  assert.equal(report.latest?.sequence, 2);
  assert.equal(report.latest?.correlation, "unavailable");
  assert.ok(report.latest?.warnings.includes("ambiguous-context-order"));
  assert.equal(report.aggregate.correlationFailures, 1);
  assert.equal(report.aggregate.eligibleRequests, 2);
  assert.equal(report.latest?.sources[0]?.characters.value, 200);
  assert.deepEqual(report.latest?.providerUsage?.input, { value: 100, measurement: "provider-reported" });
});

test("a model identity mismatch disables correlation", () => {
  const ledger = createAttributionLedger();
  startRun(ledger);
  ledger.observeContext([sourceRow("system:remainder", 100)]);
  ledger.observeProviderRequest(SAFE_MODEL);
  ledger.observeMessageEnd(assistantMessage({ model: "different-model" }));
  const report = ledger.snapshot();
  assert.equal(report.latest?.correlation, "unavailable");
  assert.ok(report.latest?.warnings.includes("correlation-unavailable"));
  assert.equal(report.aggregate.correlationFailures, 1);
  assert.deepEqual(report.latest?.providerUsage?.totalTokens, { value: 640, measurement: "provider-reported" });
});

test("message_end without a provider observation disables correlation", () => {
  const ledger = createAttributionLedger();
  startRun(ledger);
  ledger.observeContext([sourceRow("system:remainder", 100)]);
  ledger.observeMessageEnd(assistantMessage());
  const report = ledger.snapshot();
  assert.equal(report.latest?.correlation, "unavailable");
  assert.equal(report.latest?.providerRequest, "unavailable");
  assert.ok(report.latest?.warnings.includes("correlation-unavailable"));
  assert.equal(report.aggregate.correlationFailures, 1);
  assert.deepEqual(report.latest?.providerUsage?.input, { value: 100, measurement: "provider-reported" });
});

test("an unknown provider model does not fail correlation", () => {
  const ledger = createAttributionLedger();
  startRun(ledger);
  ledger.observeContext([sourceRow("system:remainder", 100)]);
  ledger.observeProviderRequest({ provider: "unavailable", api: "unavailable", model: "unavailable", measurement: "unavailable" });
  ledger.observeMessageEnd(assistantMessage());
  const report = ledger.snapshot();
  assert.equal(report.latest?.correlation, "recorded");
  assert.equal(report.latest?.model.measurement, "unavailable");
  assert.equal(report.aggregate.correlationFailures, 0);
});

test("the compaction window excludes its provider calls and invalidates stale drafts", () => {
  const ledger = createAttributionLedger();
  startRun(ledger);
  ledger.observeContext([sourceRow("system:remainder", 100)]);
  ledger.observeBeforeCompact();
  ledger.observeProviderRequest(SAFE_MODEL);
  ledger.observeMessageEnd(assistantMessage());
  ledger.observeCompact();
  ledger.observeContext([sourceRow("system:remainder", 200)]);
  ledger.observeProviderRequest(SAFE_MODEL);
  ledger.observeMessageEnd(assistantMessage());
  const report = ledger.snapshot();
  assert.equal(report.aggregate.eligibleRequests, 2);
  assert.equal(report.aggregate.excludedProviderCalls, 1);
  assert.equal(report.aggregate.correlationFailures, 0);
  assert.equal(report.latest?.status, "complete");
  assert.equal(report.latest?.correlation, "recorded");
});

test("the tree window suppresses capture and session_tree resets the ledger", () => {
  const ledger = createAttributionLedger();
  startRun(ledger);
  ledger.observeContext([sourceRow("system:remainder", 100)]);
  ledger.observeBeforeTree();
  ledger.observeProviderRequest(SAFE_MODEL);
  ledger.observeTree();
  let report = ledger.snapshot();
  assert.equal(report.latest, null);
  assert.equal(report.aggregate.eligibleRequests, 0);
  assert.equal(report.aggregate.excludedProviderCalls, 0);
  assert.equal(report.aggregate.correlationFailures, 0);
  startRun(ledger);
  completeRequest(ledger);
  report = ledger.snapshot();
  assert.equal(report.latest?.correlation, "recorded");
});

test("switch, fork, reload, and shutdown reset the ledger", () => {
  const boundaries = ["switch", "fork", "reload", "shutdown"] as const;
  for (const boundary of boundaries) {
    const ledger = createAttributionLedger();
    startRun(ledger);
    completeRequest(ledger);
    switch (boundary) {
      case "switch":
        ledger.observeBeforeSwitch();
        break;
      case "fork":
        ledger.observeBeforeFork();
        break;
      case "reload":
        ledger.observeSessionStart("reload");
        break;
      case "shutdown":
        ledger.observeShutdown();
        break;
    }
    const report = ledger.snapshot();
    assert.equal(report.latest, null, boundary);
    assert.equal(report.aggregate.eligibleRequests, 0, boundary);
    assert.equal(report.aggregate.completeProviderUsage, 0, boundary);
    assert.equal(report.aggregate.excludedProviderCalls, 0, boundary);
    assert.equal(report.aggregate.correlationFailures, 0, boundary);
    assert.deepEqual(report.aggregate.providerUsageTotals.input, { value: null, measurement: "unavailable" }, boundary);
    assert.deepEqual(report.aggregate.estimatedCharacters, {}, boundary);
    if (boundary === "reload") {
      assert.match(ledger.getDigestKey() ?? "", /^[a-f0-9]{64}$/, boundary);
    } else {
      assert.equal(ledger.getDigestKey(), undefined, boundary);
    }
    ledger.observeSessionStart("startup");
    assert.match(ledger.getDigestKey() ?? "", /^[a-f0-9]{64}$/, boundary);
  }
});

test("the runtime aggregate sums provider usage and estimated characters", () => {
  const ledger = createAttributionLedger();
  startRun(ledger);
  ledger.observeContext([sourceRow("system:remainder", 400), sourceRow("msg:user", 100)]);
  ledger.observeProviderRequest(SAFE_MODEL);
  ledger.observeMessageEnd(assistantMessage());
  ledger.observeContext([sourceRow("system:remainder", 200)]);
  ledger.observeProviderRequest(SAFE_MODEL);
  ledger.observeMessageEnd(assistantMessage());
  ledger.observeProviderRequest(SAFE_MODEL);
  const report = ledger.snapshot();
  assert.equal(report.aggregate.eligibleRequests, 2);
  assert.equal(report.aggregate.completeProviderUsage, 2);
  assert.deepEqual(report.aggregate.providerUsageTotals.input, { value: 200, measurement: "provider-reported" });
  assert.deepEqual(report.aggregate.providerUsageTotals.output, { value: 80, measurement: "provider-reported" });
  assert.deepEqual(report.aggregate.providerUsageTotals.cacheRead, { value: 1000, measurement: "provider-reported" });
  assert.deepEqual(report.aggregate.providerUsageTotals.cacheWrite, { value: 0, measurement: "provider-reported" });
  assert.deepEqual(report.aggregate.providerUsageTotals.totalTokens, { value: 1280, measurement: "provider-reported" });
  assert.deepEqual(report.aggregate.estimatedCharacters, { "system:remainder": 600, "msg:user": 100 });
  assert.equal(report.aggregate.excludedProviderCalls, 1);
  assert.equal(report.aggregate.correlationFailures, 0);
});

test("handles more than 1,000 requests without retaining request history", () => {
  const ledger = createAttributionLedger();
  startRun(ledger);
  for (let i = 0; i < 1_001; i += 1) {
    completeRequest(ledger, 10);
  }
  const report = ledger.snapshot();
  assert.equal(report.latest?.sequence, 1_001);
  assert.equal(report.aggregate.eligibleRequests, 1_001);
  assert.equal(report.aggregate.completeProviderUsage, 1_001);
  assert.deepEqual(report.aggregate.estimatedCharacters, { "system:remainder": 10_010 });
  assert.deepEqual(Object.keys(report).sort(), ["aggregate", "latest"]);
  assert.equal(report.latest?.warnings.length, 0);
});

test("a sentinel raw value never appears in the ledger snapshot", () => {
  const ledger = createAttributionLedger();
  startRun(ledger);
  ledger.observeContext([sourceRow("system:remainder", 100)]);
  ledger.observeProviderRequest(SAFE_MODEL);
  ledger.observeMessageEnd({
    role: "assistant",
    api: "openai-responses",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0.5, input: 0.2 } },
    stopReason: "stop",
    responseId: "SAFE_RESPONSE_ID_91",
    errorMessage: "SAFE_ERROR_MESSAGE_92",
    content: [{ type: "text", text: "SAFE_PROMPT_TEXT_93" }],
    timestamp: 1,
  });
  const serialized = JSON.stringify(ledger.snapshot());
  assert.ok(!serialized.includes("SAFE_RESPONSE_ID_91"));
  assert.ok(!serialized.includes("SAFE_ERROR_MESSAGE_92"));
  assert.ok(!serialized.includes("SAFE_PROMPT_TEXT_93"));
  assert.ok(!serialized.includes("0.2"));
  assert.ok(!serialized.includes("SAFE_"));
});

test("the runtime digest key stays out of the snapshot and rotates at session start", () => {
  const ledger = createAttributionLedger();
  const key = ledger.getDigestKey();
  assert.ok(key !== undefined);
  assert.match(key, /^[a-f0-9]{64}$/);
  startRun(ledger);
  completeRequest(ledger);
  assert.ok(!JSON.stringify(ledger.snapshot()).includes(key));
  ledger.observeSessionStart("new");
  const fresh = ledger.getDigestKey();
  assert.ok(fresh !== undefined);
  assert.notEqual(fresh, key);
  assert.match(fresh, /^[a-f0-9]{64}$/);
});

test("agent_settled closes the run origin and a stale pending never poisons the next run", () => {
  const ledger = createAttributionLedger();
  startRun(ledger);
  ledger.observeContext([sourceRow("system:remainder", 100)]);
  ledger.observeAgentSettled();
  let report = ledger.snapshot();
  assert.equal(report.latest?.status, "pending");
  assert.equal(report.latest?.providerRequest, "unavailable");
  ledger.observeInput("interactive");
  ledger.observeAgentStart();
  completeRequest(ledger);
  report = ledger.snapshot();
  assert.equal(report.latest?.sequence, 2);
  assert.equal(report.latest?.status, "complete");
  assert.equal(report.latest?.correlation, "recorded");
  assert.equal(report.aggregate.correlationFailures, 0);
  assert.equal(report.aggregate.eligibleRequests, 2);
});
