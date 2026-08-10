export type Measurement =
  | "provider-reported"
  | "recorded"
  | "estimated"
  | "unavailable";

export type Attribution = "attributed" | "unattributed";
export type SourceCategory = "system" | "instructions" | "skills" | "prompts" | "conversation" | "assistant" | "thinking" | "tool-call" | "tool-result" | "custom" | "memory" | "tools" | "summary" | "images" | "unattributed";
export type WarningCode = "serialization-unavailable" | "system-digest-mismatch" | "ambiguous-context-order" | "provider-usage-unavailable" | "correlation-unavailable" | "excluded-scope";
export interface LabeledValue { readonly value: number | null; readonly measurement: Measurement; }
export interface SourceEstimate { readonly key: string; readonly category: SourceCategory; readonly label: string; readonly attribution: Attribution; readonly characters: LabeledValue; readonly tokens: LabeledValue; readonly itemCount: LabeledValue; readonly warning?: WarningCode; }
export interface ProviderUsageRecord { readonly input: LabeledValue; readonly output: LabeledValue; readonly cacheRead: LabeledValue; readonly cacheWrite: LabeledValue; readonly cacheWrite1h: LabeledValue; readonly reasoning: LabeledValue; readonly totalTokens: LabeledValue; }
export interface SafeModelRecord { readonly provider: string; readonly api: string; readonly model: string; readonly measurement: "recorded" | "unavailable"; }
export interface RequestAttribution { readonly sequence: number; readonly turnIndex: number | null; readonly status: "pending" | "complete" | "error" | "aborted" | "unavailable"; readonly correlation: "recorded" | "unavailable"; readonly providerRequest: "recorded" | "unavailable"; readonly model: SafeModelRecord; readonly sources: readonly SourceEstimate[]; readonly providerUsage: ProviderUsageRecord | null; readonly warnings: readonly WarningCode[]; }
export interface RuntimeAggregate { readonly eligibleRequests: number; readonly completeProviderUsage: number; readonly providerUsageTotals: ProviderUsageRecord; readonly estimatedCharacters: Readonly<Record<string, number>>; readonly excludedProviderCalls: number; readonly correlationFailures: number; }
