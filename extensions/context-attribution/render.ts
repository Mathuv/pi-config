/**
 * Plain-text report and scrollable overlay for /context_attribution.
 *
 * renderReport is the single data source for the TUI overlay and the non-TUI
 * print path. The renderer displays sanitized labels, numeric metrics, and
 * fixed warning texts only. It never echoes source keys, raw model strings,
 * or any field that can carry prompt, result, payload, or credential text.
 */

import { MAX_LABEL_LENGTH, sanitizeLabel } from "./estimate.ts";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  LabeledValue,
  Measurement,
  ProviderUsageRecord,
  RequestAttribution,
  RuntimeAggregate,
  SourceEstimate,
  WarningCode,
} from "./types.ts";

/** Render-layer input. Structurally compatible with the ledger snapshot. */
export interface AttributionReport {
  readonly latest: RequestAttribution | null;
  /** Provider observations on the latest request. Null when no request exists. */
  readonly providerAttempts: number | null;
  readonly aggregate: RuntimeAggregate;
}

const USAGE_FIELDS: ReadonlyArray<{ key: keyof ProviderUsageRecord; label: string }> = [
  { key: "input", label: "input" },
  { key: "cacheRead", label: "cache read" },
  { key: "cacheWrite", label: "cache write" },
  { key: "cacheWrite1h", label: "cache write 1h" },
  { key: "output", label: "output" },
  { key: "reasoning", label: "reasoning" },
  { key: "totalTokens", label: "total" },
];

const WARNING_TEXTS: Record<WarningCode, string> = {
  "serialization-unavailable": "A serialization failure left a value unavailable.",
  "system-digest-mismatch": "The system prompt changed after capture; detailed system attribution is unavailable.",
  "ambiguous-context-order": "Context events arrived in an ambiguous order; correlation is unavailable.",
  "provider-usage-unavailable": "The finalized request had no usable provider usage.",
  "correlation-unavailable": "The request could not be correlated with a provider response.",
  "excluded-scope": "The request was outside the approved foreground scope.",
};

const LIMIT_LINES: readonly string[] = [
  "Exact per-source provider tokens: unavailable",
  "Later context transforms after this hook: unavailable",
  "No raw prompt, result, or provider payload data was retained.",
];

function formatNumber(value: number): string {
  const digits = String(Math.trunc(Math.abs(value)));
  return (value < 0 ? "-" : "") + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatUsageValue(value: LabeledValue): string {
  return value.value === null ? "unavailable" : formatNumber(value.value);
}

function usageRows(indent: string, usage: ProviderUsageRecord): string[] {
  return USAGE_FIELDS.map(
    ({ key, label }) => `${indent}${label.padEnd(14)} ${formatUsageValue(usage[key]).padStart(11)}`,
  );
}

function renderProviderUsage(usage: ProviderUsageRecord | null): string {
  const measurement: Measurement = usage ? "provider-reported" : "unavailable";
  const rows = usage
    ? usageRows("  ", usage)
    : USAGE_FIELDS.map(({ label }) => `  ${label.padEnd(14)} ${"unavailable".padStart(11)}`);
  return [`Provider usage [${measurement}]`, ...rows].join("\n");
}

function formatMetric(value: LabeledValue, unit: string, prefix: string): string {
  return value.value === null
    ? `unavailable ${unit} [unavailable]`
    : `${prefix}${formatNumber(value.value)} ${unit} [${value.measurement}]`;
}

/**
 * Non-destructive display guard for attribution-produced labels.
 * The attribution layer sanitizes every dynamic part. The guard only
 * removes control characters and enforces the length limit.
 */
function displayLabel(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return "unavailable";
  return cleaned.length <= MAX_LABEL_LENGTH ? cleaned : cleaned.slice(0, MAX_LABEL_LENGTH - 1) + "…";
}

function renderSourceRow(row: SourceEstimate): string {
  const chars = formatMetric(row.characters, "chars", "");
  const tokens = formatMetric(row.tokens, "tokens", "~");
  const suffix = row.attribution === "unattributed" ? " [unattributed]" : "";
  return `  ${displayLabel(row.label).padEnd(24)} ${chars}  ${tokens}${suffix}`;
}

function sortSources(sources: readonly SourceEstimate[]): SourceEstimate[] {
  return [...sources].sort((a, b) => {
    const aTokens = a.tokens.value ?? -1;
    const bTokens = b.tokens.value ?? -1;
    if (aTokens !== bTokens) return bTokens - aTokens;
    return a.key.localeCompare(b.key);
  });
}

function renderSources(sources: readonly SourceEstimate[]): string {
  const rows = sortSources(sources).map(renderSourceRow);
  return ["Context sources", ...rows].join("\n");
}

const SCOPE_TEXTS: Record<RequestAttribution["status"], string> = {
  pending: "foreground pending request",
  complete: "foreground normal request",
  error: "foreground error request",
  aborted: "foreground aborted request",
  unavailable: "foreground request",
};

function renderScope(report: AttributionReport): string {
  const latest = report.latest;
  if (!latest) {
    return "Context attribution — no recorded request\nScope: unavailable";
  }
  const lines = [
    `Context attribution — latest foreground request #${latest.sequence}`,
    `Scope: ${SCOPE_TEXTS[latest.status]} [${latest.status === "unavailable" ? "unavailable" : "recorded"}]`,
  ];
  if (report.providerAttempts !== null && report.providerAttempts > 1) {
    lines.push(`Provider attempts: ${report.providerAttempts} [recorded]`);
  }
  if (latest.model.measurement === "recorded") {
    const parts = [latest.model.provider, latest.model.api, latest.model.model].map(sanitizeLabel);
    lines.push(`Model: ${parts.join(" / ")} [recorded]`);
  } else {
    lines.push("Model: unavailable");
  }
  return lines.join("\n");
}

function renderAggregate(aggregate: RuntimeAggregate): string {
  const totals = aggregate.providerUsageTotals;
  const hasTotal = USAGE_FIELDS.some(({ key }) => totals[key].value !== null);
  const totalMeasurement: Measurement = hasTotal ? "provider-reported" : "unavailable";
  const totalCharacters = Object.values(aggregate.estimatedCharacters).reduce((sum, value) => sum + value, 0);
  return [
    "Runtime aggregate [recorded]",
    `  Eligible requests: ${aggregate.eligibleRequests}`,
    `  Complete provider usage: ${aggregate.completeProviderUsage}`,
    `  Provider usage totals [${totalMeasurement}]`,
    ...usageRows("    ", totals),
    `  Excluded provider calls: ${aggregate.excludedProviderCalls}`,
    `  Correlation failures: ${aggregate.correlationFailures}`,
    `  Estimated characters: ${formatNumber(totalCharacters)}`,
  ].join("\n");
}

function renderWarnings(warnings: readonly WarningCode[]): string {
  const unique = [...new Set(warnings)];
  if (unique.length === 0) return "";
  return ["Warnings", ...unique.map((code) => `  - ${WARNING_TEXTS[code]}`)].join("\n");
}

/** Plain-text report. The only data source for the TUI and print paths. */
export function renderReport(report: AttributionReport): string {
  const parts: string[] = [
    renderScope(report),
    renderProviderUsage(report.latest?.providerUsage ?? null),
    renderSources(report.latest?.sources ?? []),
    renderAggregate(report.aggregate),
    LIMIT_LINES.join("\n"),
  ];
  const warnings = renderWarnings(report.latest?.warnings ?? []);
  if (warnings) parts.push(warnings);
  return parts.join("\n\n");
}

/**
 * Small scrollable view over the plain-text report.
 * Pure component: no TUI instance required for unit tests.
 */
export class ScrollableReportView {
  private readonly lines: readonly string[];
  private readonly onClose?: () => void;
  private offset = 0;
  private height = 0;
  private closed = false;

  constructor(reportText: string, onClose?: () => void) {
    this.lines = reportText.split("\n");
    this.onClose = onClose;
  }

  get scrollOffset(): number {
    return this.offset;
  }

  get lineCount(): number {
    return this.lines.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
      this.closed = true;
      this.onClose?.();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scrollBy(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scrollBy(1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollBy(-Math.max(1, this.height));
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollBy(Math.max(1, this.height));
    }
  }

  private scrollBy(delta: number): void {
    const maxScroll = Math.max(0, this.lines.length - this.height);
    this.offset = Math.max(0, Math.min(this.offset + delta, maxScroll));
  }

  render(width: number, height: number): string[] {
    this.height = Math.max(1, height);
    const maxScroll = Math.max(0, this.lines.length - this.height);
    this.offset = Math.max(0, Math.min(this.offset, maxScroll));
    return this.lines
      .slice(this.offset, this.offset + this.height)
      .map((line) => truncateToWidth(line, Math.max(1, width)));
  }
}

/**
 * Shows the sanitized report. Opens a scrollable overlay in TUI mode and
 * prints the same plain text in every other mode. Adds no session content.
 */
export async function showContextAttribution(report: AttributionReport, ctx: ExtensionContext): Promise<void> {
  const text = renderReport(report);
  if (ctx.mode !== "tui") {
    console.log(text);
    return;
  }
  await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
    const view = new ScrollableReportView(text, () => done());
    const component = {
      get focused(): boolean {
        return true;
      },
      set focused(_value: boolean) {},
      render(width: number): string[] {
        // The overlay caps the content at floor(rows * 0.8). Read the
        // terminal height on every render so a resize while the overlay is
        // open cannot leave the bottom lines unreachable.
        const height = Math.max(1, Math.floor((tui.terminal.rows || 24) * 0.8));
        return view.render(width, height);
      },
      invalidate(): void {},
      handleInput(data: string): void {
        view.handleInput(data);
      },
    };
    return component;
  }, { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" } });
}
