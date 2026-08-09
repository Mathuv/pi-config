import { createHmac, randomBytes } from "node:crypto";
import { isAbsolute, win32, posix } from "node:path";
import type { LabeledValue, ProviderUsageRecord } from "./types.ts";
export type { LabeledValue, ProviderUsageRecord, SourceEstimate } from "./types.ts";
export const CHARS_PER_TOKEN = 4;
export const IMAGE_CHARACTERS = 4_800;
export const MAX_LABEL_LENGTH = 120;
const runtimeDigestKey = randomBytes(32).toString("hex");
export function estimateTokens(characters: number): number { return Number.isFinite(characters) ? Math.ceil(Math.max(0, characters) / CHARS_PER_TOKEN) : 0; }
export function estimateImageCharacters(count: number): number { const result = Number.isFinite(count) ? Math.max(0, count) * IMAGE_CHARACTERS : 0; return Number.isFinite(result) ? result : 0; }
export function countJsonCharacters(value: unknown): number | null { try { const serialized = JSON.stringify(value); return serialized === undefined ? null : serialized.length; } catch { return null; } }
export function recordedValue(value: number | null | undefined): LabeledValue { return finiteValue(value, "recorded"); }
export function estimatedValue(value: number | null | undefined): LabeledValue { return finiteValue(value, "estimated"); }
export function providerReportedValue(value: number | null | undefined): LabeledValue { return finiteValue(value, "provider-reported"); }
export function unavailableValue(): LabeledValue { return { value: null, measurement: "unavailable" }; }
function finiteValue(value: number | null | undefined, measurement: "recorded" | "estimated" | "provider-reported"): LabeledValue { return typeof value === "number" && Number.isFinite(value) ? { value, measurement } : unavailableValue(); }
export function providerUsageRecord(usage: Partial<Record<keyof ProviderUsageRecord, number>> | null | undefined): ProviderUsageRecord { return { input: providerReportedValue(usage?.input), output: providerReportedValue(usage?.output), cacheRead: providerReportedValue(usage?.cacheRead), cacheWrite: providerReportedValue(usage?.cacheWrite), cacheWrite1h: providerReportedValue(usage?.cacheWrite1h), reasoning: providerReportedValue(usage?.reasoning), totalTokens: providerReportedValue(usage?.totalTokens) }; }
export function sanitizeLabel(value: unknown): string {
  if (typeof value !== "string") return "unavailable";
  const cleaned = cleanText(value);
  if (!cleaned) return "unavailable";
  if (looksLikeUrl(cleaned)) return sanitizeUrlLabel(cleaned);
  if (isPathValue(cleaned)) return sanitizePathLabel(cleaned);
  return truncate(cleaned);
}
export function sanitizePathLabel(value: unknown, cwd = process.cwd(), home = process.env.HOME ?? ""): string {
  if (typeof value !== "string") return "unavailable";
  const cleaned = cleanText(value);
  if (!cleaned) return "unavailable";
  const style = isWindowsPath(cleaned) || isWindowsPath(cwd) || isWindowsPath(home) ? win32 : posix;
  const normalizedCwd = cwd || process.cwd();
  const normalizedHome = home || "";
  const expanded = cleaned.startsWith("~") && normalizedHome ? normalizedHome + cleaned.slice(1) : cleaned;
  const normalized = style.resolve(normalizedCwd, expanded);
  if (isWithin(normalized, normalizedCwd, style)) return truncatePath("$CWD", style.relative(normalizedCwd, normalized));
  if (normalizedHome && isWithin(normalized, normalizedHome, style)) return truncatePath("$HOME", style.relative(normalizedHome, normalized));
  return truncatePath("<external>", style.basename(normalized));
}
export function sanitizeUrlLabel(value: unknown): string {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return "unavailable";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") return "unavailable";
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    return truncate(url.toString().replace(/\/$/, ""));
  } catch { return "unavailable"; }
}
function cleanText(value: string): string { return value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim(); }
function isPathValue(value: string): boolean { return isAbsolute(value) || /^~(?:[\\/]|$)/.test(value) || isWindowsPath(value); }
function isWindowsPath(value: string): boolean { return /^[A-Za-z]:[\\/]/.test(value) || /^\\/.test(value); }
function looksLikeUrl(value: string): boolean { return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !isWindowsPath(value); }
function isWithin(value: string, parent: string, style: typeof posix | typeof win32): boolean { const child = style.relative(parent, value); return child === "" || (child !== ".." && !child.startsWith(".." + style.sep) && !style.isAbsolute(child)); }
function truncatePath(prefix: string, value: string): string { const suffix = value ? value.split(/[\\/]+/).filter(Boolean).join("/") : ""; return truncate(suffix ? prefix + "/" + suffix : prefix); }
function truncate(value: string): string { return value.length <= MAX_LABEL_LENGTH ? value : value.slice(0, MAX_LABEL_LENGTH - 1) + "…"; }
export async function createRuntimeDigest(value: string, key?: string): Promise<string> { return createHmac("sha256", key ?? runtimeDigestKey).update(value).digest("hex"); }
