import { createHmac, randomBytes } from "node:crypto";
import { basename, isAbsolute, relative, sep } from "node:path";
import type { LabeledValue, ProviderUsageRecord } from "./types.ts";
export type { LabeledValue, ProviderUsageRecord, SourceEstimate } from "./types.ts";
export const CHARS_PER_TOKEN = 4;
export const IMAGE_CHARACTERS = 4_800;
export const MAX_LABEL_LENGTH = 120;
export function estimateTokens(characters: number): number { return Math.ceil(Math.max(0, characters) / CHARS_PER_TOKEN); }
export function estimateImageCharacters(count: number): number { return Math.max(0, count) * IMAGE_CHARACTERS; }
export function countJsonCharacters(value: unknown): number | null { try { const serialized = JSON.stringify(value); return serialized === undefined ? null : serialized.length; } catch { return null; } }
export function recordedValue(value: number | null | undefined): LabeledValue { return finiteValue(value, "recorded"); }
export function estimatedValue(value: number | null | undefined): LabeledValue { return finiteValue(value, "estimated"); }
export function providerReportedValue(value: number | null | undefined): LabeledValue { return finiteValue(value, "provider-reported"); }
export function unavailableValue(): LabeledValue { return { value: null, measurement: "unavailable" }; }
function finiteValue(value: number | null | undefined, measurement: "recorded" | "estimated" | "provider-reported"): LabeledValue { return typeof value === "number" && Number.isFinite(value) ? { value, measurement } : unavailableValue(); }
export function providerUsageRecord(usage: Partial<Record<keyof ProviderUsageRecord, number>> | null | undefined): ProviderUsageRecord { return { input: providerReportedValue(usage?.input), output: providerReportedValue(usage?.output), cacheRead: providerReportedValue(usage?.cacheRead), cacheWrite: providerReportedValue(usage?.cacheWrite), cacheWrite1h: providerReportedValue(usage?.cacheWrite1h), reasoning: providerReportedValue(usage?.reasoning), totalTokens: providerReportedValue(usage?.totalTokens) }; }
export function sanitizeLabel(value: unknown): string {
  if (typeof value !== "string") return "unavailable";
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return "unavailable";
  if (looksLikeUrl(cleaned)) return sanitizeUrlLabel(cleaned);
  if (isAbsolute(cleaned) || /^~(?:[\\/]|$)/.test(cleaned) || /^[A-Za-z]:[\\/]/.test(cleaned)) return sanitizePathLabel(cleaned);
  return truncate(cleaned);
}
export function sanitizePathLabel(value: unknown, cwd = process.cwd(), home = process.env.HOME ?? ""): string {
  if (typeof value !== "string") return "unavailable";
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  if (!cleaned) return "unavailable";
  const normalized = cleaned.startsWith("~") && home ? home + cleaned.slice(1) : cleaned;
  const normalizedCwd = cwd || process.cwd();
  const normalizedHome = home || "";
  if (isWithin(normalized, normalizedCwd)) return truncate("$CWD/" + relative(normalizedCwd, normalized));
  if (normalizedHome && isWithin(normalized, normalizedHome)) return truncate("$HOME/" + relative(normalizedHome, normalized));
  return truncate("<external>/" + basename(normalized));
}
export function sanitizeUrlLabel(value: unknown): string {
  if (typeof value !== "string") return "unavailable";
  try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return truncate(url.toString().replace(/\/$/, "")); } catch { return "unavailable"; }
}
function looksLikeUrl(value: string): boolean { return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value); }
function isWithin(value: string, parent: string): boolean { const child = relative(parent, value); return child === "" || (child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child)); }
function truncate(value: string): string { return value.length <= MAX_LABEL_LENGTH ? value : value.slice(0, MAX_LABEL_LENGTH - 1) + "…"; }
export async function createRuntimeDigest(value: string, key?: string): Promise<string> { const runtimeKey = key ?? randomBytes(32).toString("hex"); return createHmac("sha256", runtimeKey).update(value).digest("hex"); }
