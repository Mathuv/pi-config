import { randomBytes } from "node:crypto";
import { providerUsageRecord, unavailableValue } from "./estimate.ts";
import type {
  LabeledValue,
  ProviderUsageRecord,
  RequestAttribution,
  RuntimeAggregate,
  SafeModelRecord,
  SourceEstimate,
  WarningCode,
} from "./types.ts";

/**
 * Private runtime ledger for the latest eligible foreground request.
 *
 * The ledger correlates one eligible context snapshot with one provider
 * observation and one finalized assistant usage record. It keeps only the
 * latest request and cumulative numeric maps. Every raw runtime value stays
 * inside the observer call that received it. The ledger never reads a session,
 * database, index, or provider payload, and it performs no I/O.
 *
 * Run origin: an idle input with source "interactive" or "rpc" makes the next
 * run eligible. An idle extension input makes the next run ineligible.
 * Intercom delivers its messages without an input event, so an intercom-
 * triggered continuation cannot set the in-run suppression flag.
 */

export interface LedgerSnapshot {
  readonly latest: RequestAttribution | null;
  readonly aggregate: RuntimeAggregate;
}

export interface AttributionLedger {
  observeSessionStart(reason?: string): void;
  observeInput(source: string): void;
  observeAgentStart(): void;
  observeContext(sources: readonly SourceEstimate[]): void;
  observeProviderRequest(model: SafeModelRecord): void;
  observeMessageEnd(message: unknown): void;
  observeAgentSettled(): void;
  observeBeforeCompact(): void;
  observeCompact(): void;
  observeBeforeTree(): void;
  observeTree(): void;
  observeBeforeSwitch(): void;
  observeBeforeFork(): void;
  observeShutdown(): void;
  getDigestKey(): string | undefined;
  snapshot(): LedgerSnapshot;
}

type RequestStatus = "pending" | "complete" | "error" | "aborted" | "unavailable";

interface Draft {
  sequence: number;
  status: RequestStatus;
  correlation: "recorded" | "unavailable";
  providerRequest: "recorded" | "unavailable";
  model: SafeModelRecord;
  sources: readonly SourceEstimate[];
  providerUsage: ProviderUsageRecord | null;
  warnings: WarningCode[];
  providerAttempts: number;
  providerObserved: boolean;
  /** True when the correlation failure for this draft was already counted. */
  ambiguityCounted: boolean;
}

/** Mutable accumulator for provider usage totals. The snapshot returns the readonly shape. */
type MutableUsageTotals = { -readonly [K in keyof ProviderUsageRecord]: LabeledValue };

interface AggregateState {
  eligibleRequests: number;
  completeProviderUsage: number;
  providerUsageTotals: MutableUsageTotals;
  estimatedCharacters: Record<string, number>;
  excludedProviderCalls: number;
  correlationFailures: number;
}

const USAGE_KEYS: ReadonlyArray<keyof ProviderUsageRecord> = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "cacheWrite1h",
  "reasoning",
  "totalTokens",
];

const UNAVAILABLE_MODEL: SafeModelRecord = {
  provider: "unavailable",
  api: "unavailable",
  model: "unavailable",
  measurement: "unavailable",
};

function zeroTotals(): MutableUsageTotals {
  return {
    input: unavailableValue(),
    output: unavailableValue(),
    cacheRead: unavailableValue(),
    cacheWrite: unavailableValue(),
    cacheWrite1h: unavailableValue(),
    reasoning: unavailableValue(),
    totalTokens: unavailableValue(),
  };
}

function cleanModelField(value: unknown): string {
  if (typeof value !== "string") return "unavailable";
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, "").trim();
  if (!cleaned) return "unavailable";
  return cleaned.length > 120 ? cleaned.slice(0, 119) + "…" : cleaned;
}

function sanitizeSafeModel(value: unknown): SafeModelRecord {
  const record = (value ?? {}) as Record<string, unknown>;
  const provider = cleanModelField(record.provider);
  const api = cleanModelField(record.api);
  const model = cleanModelField(record.model);
  const measurement = provider !== "unavailable" && api !== "unavailable" && model !== "unavailable" ? "recorded" : "unavailable";
  return { provider, api, model, measurement };
}

function hasSubagentEnvironment(env: Readonly<Record<string, string | undefined>>): boolean {
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_SUBAGENT_")) return true;
  }
  return false;
}

/** Extracts the normalized identity of a finalized assistant message. */
function messageIdentity(message: Record<string, unknown>): { provider: string; api: string; model: string } | null {
  const provider = typeof message.provider === "string" ? message.provider : "";
  const api = typeof message.api === "string" ? message.api : "";
  const model = typeof message.model === "string" ? message.model : "";
  if (!provider || !api || !model) return null;
  return { provider, api, model };
}

/** Copies every finite provider usage value exactly. Never recomputes totalTokens. */
function copyUsage(message: Record<string, unknown>): ProviderUsageRecord | null {
  const usage = message.usage;
  if (!usage || typeof usage !== "object") return null;
  const record = providerUsageRecord(usage as Partial<Record<keyof ProviderUsageRecord, number>>);
  const hasFinite = USAGE_KEYS.some((key) => record[key].value !== null);
  return hasFinite ? record : null;
}

function addToTotals(totals: MutableUsageTotals, usage: ProviderUsageRecord): void {
  for (const key of USAGE_KEYS) {
    const value = usage[key].value;
    if (value === null) continue;
    const current = totals[key].value;
    totals[key] = current === null ? { value, measurement: "provider-reported" } : { value: current + value, measurement: "provider-reported" };
  }
}

function addWarning(draft: Draft, code: WarningCode): void {
  if (!draft.warnings.includes(code)) draft.warnings.push(code);
}

function stopStatus(stopReason: unknown): RequestStatus {
  if (stopReason === "error") return "error";
  if (stopReason === "aborted") return "aborted";
  return "complete";
}

export function createAttributionLedger(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AttributionLedger {
  let runOrigin: string | undefined;
  let runActive = false;
  let runEligible = false;
  let suppressNextDraft = false;
  let compacting = false;
  let treeWindow = false;
  let current: Draft | null = null;
  let sequence = 0;
  let digestKey: string | undefined = randomBytes(32).toString("hex");
  const aggregate: AggregateState = {
    eligibleRequests: 0,
    completeProviderUsage: 0,
    providerUsageTotals: zeroTotals(),
    estimatedCharacters: {},
    excludedProviderCalls: 0,
    correlationFailures: 0,
  };

  /** Resets request state and cumulative counters. Keeps the runtime digest key. */
  function resetCounters(): void {
    runOrigin = undefined;
    runActive = false;
    runEligible = false;
    suppressNextDraft = false;
    compacting = false;
    treeWindow = false;
    current = null;
    sequence = 0;
    aggregate.eligibleRequests = 0;
    aggregate.completeProviderUsage = 0;
    aggregate.providerUsageTotals = zeroTotals();
    aggregate.estimatedCharacters = {};
    aggregate.excludedProviderCalls = 0;
    aggregate.correlationFailures = 0;
  }

  function createDraft(sources: readonly SourceEstimate[], ambiguous: boolean): void {
    sequence += 1;
    current = {
      sequence,
      status: "pending",
      correlation: ambiguous ? "unavailable" : "recorded",
      providerRequest: "unavailable",
      model: UNAVAILABLE_MODEL,
      sources: Array.isArray(sources) ? sources : [],
      providerUsage: null,
      warnings: ambiguous ? ["ambiguous-context-order"] : [],
      providerAttempts: 0,
      providerObserved: false,
      ambiguityCounted: ambiguous,
    };
    aggregate.eligibleRequests += 1;
    for (const row of current.sources) {
      const characters = row?.characters?.value;
      if (typeof row?.key === "string" && typeof characters === "number" && Number.isFinite(characters)) {
        aggregate.estimatedCharacters[row.key] = (aggregate.estimatedCharacters[row.key] ?? 0) + characters;
      }
    }
  }

  function finalize(draft: Draft, message: Record<string, unknown>): void {
    draft.status = stopStatus(message.stopReason);
    const usage = copyUsage(message);
    if (usage === null) {
      draft.providerUsage = null;
      addWarning(draft, "provider-usage-unavailable");
    } else {
      draft.providerUsage = usage;
      aggregate.completeProviderUsage += 1;
      addToTotals(aggregate.providerUsageTotals, usage);
    }
    if (draft.ambiguityCounted) {
      return;
    }
    const identity = messageIdentity(message);
    const modelMismatch =
      draft.model.measurement === "recorded" &&
      identity !== null &&
      (draft.model.provider !== identity.provider || draft.model.api !== identity.api || draft.model.model !== identity.model);
    if (modelMismatch || !draft.providerObserved) {
      aggregate.correlationFailures += 1;
      draft.correlation = "unavailable";
      addWarning(draft, "correlation-unavailable");
    }
  }

  function toRequest(draft: Draft): RequestAttribution {
    return {
      sequence: draft.sequence,
      status: draft.status,
      correlation: draft.correlation,
      providerRequest: draft.providerRequest,
      model: draft.model,
      sources: [...draft.sources],
      providerUsage: draft.providerUsage,
      warnings: [...draft.warnings],
    };
  }

  function toAggregate(): RuntimeAggregate {
    return {
      eligibleRequests: aggregate.eligibleRequests,
      completeProviderUsage: aggregate.completeProviderUsage,
      providerUsageTotals: { ...aggregate.providerUsageTotals },
      estimatedCharacters: { ...aggregate.estimatedCharacters },
      excludedProviderCalls: aggregate.excludedProviderCalls,
      correlationFailures: aggregate.correlationFailures,
    };
  }

  return {
    observeSessionStart(): void {
      resetCounters();
      digestKey = randomBytes(32).toString("hex");
    },

    observeInput(source: string): void {
      const value = typeof source === "string" ? source : "";
      if (runActive) {
        // An extension input during a run suppresses the next context draft.
        // Intercom never emits an input event, so this cannot suppress an
        // intercom-triggered continuation.
        if (value === "extension") suppressNextDraft = true;
        return;
      }
      runOrigin = value;
    },

    observeAgentStart(): void {
      // A pending draft that survived agent_settled belongs to a closed run.
      // Drop it so a new run starts without a false ambiguity.
      if (current && current.status === "pending") current = null;
      runActive = true;
      runEligible = (runOrigin === "interactive" || runOrigin === "rpc") && !hasSubagentEnvironment(env);
    },

    observeContext(sources: readonly SourceEstimate[]): void {
      if (!runActive || !runEligible || compacting || treeWindow) return;
      if (suppressNextDraft) {
        suppressNextDraft = false;
        return;
      }
      const ambiguous = current !== null && current.status === "pending";
      if (ambiguous) aggregate.correlationFailures += 1;
      createDraft(sources, ambiguous);
    },

    observeProviderRequest(model: SafeModelRecord): void {
      const safe = sanitizeSafeModel(model);
      if (!runActive || !current || current.status !== "pending") {
        aggregate.excludedProviderCalls += 1;
        return;
      }
      current.providerAttempts += 1;
      current.providerObserved = true;
      current.model = safe;
      current.providerRequest = "recorded";
    },

    observeMessageEnd(message: unknown): void {
      if (!message || typeof message !== "object") return;
      const record = message as Record<string, unknown>;
      if (record.role !== "assistant") return;
      if (!current || current.status !== "pending") return;
      finalize(current, record);
    },

    observeAgentSettled(): void {
      runActive = false;
      runEligible = false;
      runOrigin = undefined;
      suppressNextDraft = false;
    },

    observeBeforeCompact(): void {
      compacting = true;
      if (current && current.status === "pending") current = null;
    },

    observeCompact(): void {
      compacting = false;
    },

    observeBeforeTree(): void {
      treeWindow = true;
      if (current && current.status === "pending") current = null;
    },

    observeTree(): void {
      treeWindow = false;
      resetCounters();
    },

    observeBeforeSwitch(): void {
      resetCounters();
    },

    observeBeforeFork(): void {
      resetCounters();
    },

    observeShutdown(): void {
      resetCounters();
      digestKey = undefined;
    },

    getDigestKey(): string | undefined {
      return digestKey;
    },

    snapshot(): LedgerSnapshot {
      return {
        latest: current ? toRequest(current) : null,
        aggregate: toAggregate(),
      };
    },
  };
}
