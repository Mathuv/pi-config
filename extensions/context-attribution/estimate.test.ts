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

test("removes query and fragment data from plain identifiers and path basenames", () => {
  assert.equal(sanitizeLabel("gpt-5.6-sol?token=MODEL_QUERY_MARKER#frag"), "gpt-5.6-sol");
  assert.equal(sanitizeLabel("gpt-5.6-sol?token=MODEL_QUERY_MARKER"), "gpt-5.6-sol");
  assert.equal(sanitizeLabel("gpt-5.6-sol#frag"), "gpt-5.6-sol");
  assert.equal(sanitizeLabel("openai-codex?token=PROVIDER_QUERY_MARKER"), "openai-codex");
  assert.equal(
    sanitizePathLabel("/external/api?token=PATH_QUERY_MARKER#frag", "/Users/alice/project", "/Users/alice"),
    "<external>/api",
  );
  assert.equal(sanitizeLabel("/external/api?token=PATH_QUERY_MARKER#frag"), "<external>/api");
  assert.doesNotMatch(sanitizeLabel("gpt-5.6-sol?token=MODEL_QUERY_MARKER#frag"), /MODEL_QUERY_MARKER|#frag|\?token=/);
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


test("normalizes non-finite estimator inputs", () => {
  assert.equal(estimateTokens(Number.NaN), 0);
  assert.equal(estimateTokens(Number.POSITIVE_INFINITY), 0);
  assert.equal(estimateImageCharacters(Number.NaN), 0);
  assert.equal(estimateImageCharacters(Number.POSITIVE_INFINITY), 0);
});

test("records provider usage and marks missing fields unavailable", async () => {
  const { providerUsageRecord } = await import("./estimate.ts");
  const usage = providerUsageRecord({ input: 0, output: 3, totalTokens: 3 });
  assert.deepEqual(usage.input, { value: 0, measurement: "provider-reported" });
  assert.deepEqual(usage.output, { value: 3, measurement: "provider-reported" });
  assert.deepEqual(usage.cacheRead, { value: null, measurement: "unavailable" });
  assert.deepEqual(usage.reasoning, { value: null, measurement: "unavailable" });
});

test("resolves relative paths against the supplied cwd", () => {
  assert.equal(sanitizePathLabel("src/file.ts", "/Users/alice/project", "/Users/alice"), "$CWD/src/file.ts");
});

test("redacts Windows absolute paths without exposing the prefix", () => {
  const label = sanitizePathLabel("C:\\Users\\alice\\private\\file.ts", "C:\\Users\\alice\\project", "C:\\Users\\alice");
  assert.equal(label, "$HOME/private/file.ts");
  assert.doesNotMatch(label, /C:|Users|alice/);
});

test("rejects file URLs and sanitizes opaque URLs", () => {
  assert.equal(sanitizeUrlLabel("file:///Users/alice/private.txt"), "unavailable");
  assert.equal(sanitizeLabel("mailto:user@example.test?subject=SAFE_FIXTURE_ONLY#fragment"), "mailto:user@example.test");
  assert.equal(sanitizeLabel("https://user:pass@example.test/a?query=SAFE_FIXTURE_ONLY#fragment"), "https://example.test/a");
  assert.equal(sanitizeLabel("https:\u0000//example.test/secret"), "unavailable");
});

test("keeps the runtime digest out of report data and correlates default digests", async () => {
  const first = await createRuntimeDigest("SAFE_FIXTURE_ONLY");
  const second = await createRuntimeDigest("SAFE_FIXTURE_ONLY");
  assert.equal(first, second);
  const report = { sources: [{ label: "safe", key: "source" }], digest: undefined };
  assert.equal(JSON.stringify(report).includes(first), false);
  assert.equal(JSON.stringify(report).includes("SAFE_FIXTURE_ONLY"), false);
});

test("detects URLs after cleaning leading controls and spaces", () => {
  assert.equal(sanitizeLabel("\thttps://user:pass@example.test/a?q=secret#x"), "https://example.test/a");
  assert.equal(sanitizeLabel("   https://user:pass@example.test/a?q=secret#x"), "https://example.test/a");
  assert.doesNotMatch(sanitizeLabel("\thttps://user:pass@example.test/a?q=secret#x"), /user:pass|\?q=secret|#x/);
});

test("redacts Windows root-relative absolute paths", () => {
  const label = sanitizeLabel("\\Users\\alice\\secret.txt");
  assert.match(label, /^<external>\/secret\.txt$/);
  assert.doesNotMatch(label, /alice|Users|\\/);
});

test("keeps image estimates finite for finite counts", () => {
  const result = estimateImageCharacters(Number.MAX_VALUE);
  assert.equal(Number.isFinite(result), true);
  assert.equal(result >= 0, true);
  assert.equal(result, 0);
});

test("decodes encoded delimiters so model labels cannot hide query or fragment data", () => {
  assert.equal(sanitizeLabel("openai-codex%3Ftoken=ENCODED_PROVIDER_QUERY"), "openai-codex");
  assert.equal(sanitizeLabel("gpt%3Ftoken=ENCODED_MODEL_QUERY%23ENCODED_MODEL_FRAGMENT"), "gpt");
  assert.equal(sanitizeLabel("gpt%3Ftoken%3DENCODED_MODEL_QUERY%23ENCODED_MODEL_FRAGMENT"), "gpt");
  assert.equal(sanitizeLabel("/external/api%3Ftoken=PATH_ENC%23frag"), "<external>/api");
  const label = sanitizeLabel("gpt%3Ftoken=ENCODED_MODEL_QUERY%23ENCODED_MODEL_FRAGMENT");
  assert.doesNotMatch(label, /ENCODED|%3F|%23|\?|#/);
});

test("decodes nested-encoded delimiters before privacy normalization", () => {
  assert.equal(sanitizeLabel("gpt%253Ftoken%253DNESTED_QUERY%2523frag"), "gpt");
  assert.equal(sanitizeLabel("openai-codex%253Ftoken%253DNESTED_PROVIDER"), "openai-codex");
  assert.equal(sanitizeLabel("%253Fquery-only"), "unavailable");
});

test("decodes fully-encoded credential URLs before sanitization", () => {
  const label = sanitizeLabel("https%3A%2F%2Fuser%3Apass%40example.test%2Fmodel%3Fq%3DENC%23frag");
  assert.equal(label, "https://example.test/model");
  assert.doesNotMatch(label, /user|pass|ENC|%40|%3F|%23/);
});

test("rejects control-obfuscated URLs that cannot become a safe identifier", () => {
  assert.equal(sanitizeLabel("h\u0000ttps://user:pass@example.test/model?q=CONTROL_QUERY#frag"), "unavailable");
  assert.equal(sanitizeLabel("https\u0000//user:pass@example.test/model?q=CONTROL_QUERY#frag"), "unavailable");
  const userinfo = sanitizeLabel("https://user\u0000:pass@example.test/model?q=CONTROL_QUERY#frag");
  assert.doesNotMatch(userinfo, /user:pass|CONTROL_QUERY|#frag|@/);
});

test("treats query-only, fragment-only, and empty-base labels as unavailable", () => {
  for (const value of ["?query-only", "#fragment-only", "?", "#", "%3Fquery-only", "%23fragment-only", "?q=1#f"]) {
    assert.equal(sanitizeLabel(value), "unavailable", JSON.stringify(value));
  }
});

test("keeps normal provider and model identifiers useful and stable", () => {
  assert.equal(sanitizeLabel("openai-codex"), "openai-codex");
  assert.equal(sanitizeLabel("gpt-5.6-sol"), "gpt-5.6-sol");
  assert.equal(sanitizeLabel("deepseek-v4-flash"), "deepseek-v4-flash");
  assert.equal(sanitizeLabel("openai-responses"), "openai-responses");
});
