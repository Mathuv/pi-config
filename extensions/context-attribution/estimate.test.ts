import assert from "node:assert/strict";
import { test } from "node:test";
import {
  countJsonCharacters,
  estimateImageCharacters,
  estimateTokens,
  sanitizeLabel,
  sanitizePathLabel,
  sanitizeUrlLabel,
  createRuntimeDigest,
  type LabeledValue,
  type ProviderUsageRecord,
  type SourceEstimate,
} from "./estimate.ts";

test("estimates tokens from non-negative character counts", () => {
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(-10), 0);
  assert.equal(estimateTokens(1.1), 1);
  assert.equal(estimateTokens(9), 3);
  assert.equal(estimateTokens(1_000_000), 250_000);
});

test("estimates image characters with the approved constant", () => {
  assert.equal(estimateImageCharacters(0), 0);
  assert.equal(estimateImageCharacters(-2), 0);
  assert.equal(estimateImageCharacters(3), 14_400);
});

test("counts serializable JSON and rejects cyclic values without exposing errors", () => {
  assert.equal(countJsonCharacters({ safe: "value" }), JSON.stringify({ safe: "value" }).length);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(countJsonCharacters(cyclic), null);
});

test("supports every approved measurement label and provider zero values", () => {
  const values: LabeledValue[] = [
    { value: 0, measurement: "provider-reported" },
    { value: 1, measurement: "recorded" },
    { value: 2, measurement: "estimated" },
    { value: null, measurement: "unavailable" },
  ];
  assert.equal(values[0].value, 0);
  const usage: ProviderUsageRecord = {
    input: values[0], output: values[0], cacheRead: values[0], cacheWrite: values[0],
    cacheWrite1h: values[0], reasoning: values[0], totalTokens: values[0],
  };
  assert.equal(usage.totalTokens.value, 0);
});

test("sanitizes labels and removes sensitive path and URL components", () => {
  assert.equal(sanitizePathLabel("/Users/alice/project/src/file.ts", "/Users/alice/project", "/Users/alice"), "$CWD/src/file.ts");
  assert.equal(sanitizePathLabel("/Users/alice/.secret/token.txt", "/Users/alice/project", "/Users/alice"), "$HOME/.secret/token.txt");
  assert.match(sanitizePathLabel("/other/secret/file.ts", "/Users/alice/project", "/Users/alice"), /^<external>\/file\.ts$/);
  assert.equal(sanitizeUrlLabel("https://user:pass@example.test/a?q=secret#fragment"), "https://example.test/a");
  assert.equal(sanitizeLabel("safe\u0000\u0007 label"), "safe label");
  assert.ok(sanitizeLabel("x".repeat(200)).length <= 120);
});

test("runtime HMAC digest is separate from report data", async () => {
  const digest = await createRuntimeDigest("SAFE_FIXTURE_ONLY", "runtime-only-secret");
  assert.match(digest, /^[a-f0-9]{64}$/);
  const row: SourceEstimate = {
    key: "source", category: "conversation", label: "safe", attribution: "attributed",
    characters: { value: 4, measurement: "recorded" }, tokens: { value: 1, measurement: "estimated" },
    itemCount: { value: 1, measurement: "recorded" },
  };
  assert.equal(JSON.stringify(row).includes("SAFE_FIXTURE_ONLY"), false);
  assert.notEqual(digest, "SAFE_FIXTURE_ONLY");
});
