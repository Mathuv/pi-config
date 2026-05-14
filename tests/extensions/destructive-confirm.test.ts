/**
 * Tests for the destructive-confirm extension scaffold.
 *
 * Covers:
 * - Default enabled state
 * - /destructive-confirm and /dc command registration
 * - session_start status initialization
 * - Toggle behavior (enabled -> disabled -> enabled)
 * - Status updates after toggle
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// Mock the pi module — the extension only uses type imports at runtime.
vi.mock("@mariozechner/pi-coding-agent", () => ({}));

function createMockPi(): ExtensionAPI {
  const registerCommand = vi.fn();
  const on = vi.fn();
  return { registerCommand, on } as unknown as ExtensionAPI;
}

function createMockCtx(): ExtensionContext {
  const setStatus = vi.fn();
  const notify = vi.fn();

  return {
    ui: {
      setStatus,
      notify,
      theme: {
        fg: vi.fn((_color: string, text: string) => text),
      },
    },
    hasUI: true,
    cwd: "/test",
  } as unknown as ExtensionContext;
}

describe("destructive-confirm extension", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should register /destructive-confirm and /dc commands on load", async () => {
    const pi = createMockPi();
    const mod = await import("../../extensions/destructive-confirm/index.js");
    mod.default(pi);

    expect(pi.registerCommand).toHaveBeenCalledWith(
      "destructive-confirm",
      expect.objectContaining({
        description: expect.any(String),
        handler: expect.any(Function),
      }),
    );
    expect(pi.registerCommand).toHaveBeenCalledWith(
      "dc",
      expect.objectContaining({
        description: expect.any(String),
        handler: expect.any(Function),
      }),
    );
  });

  it("should listen for session_start event", async () => {
    const pi = createMockPi();
    const mod = await import("../../extensions/destructive-confirm/index.js");
    mod.default(pi);

    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
  });

  it("should initialize and show enabled status on session_start", async () => {
    const pi = createMockPi();
    const mod = await import("../../extensions/destructive-confirm/index.js");
    mod.default(pi);

    const ctx = createMockCtx();
    const sessionStartHandler = (
      pi.on as ReturnType<typeof vi.fn>
    ).mock.calls.find((c: unknown[]) => c[0] === "session_start")?.[1];

    await (sessionStartHandler as Function)({}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "destructive-confirm",
      expect.any(String),
    );
    // Status should be set exactly once during session start
    expect(ctx.ui.setStatus).toHaveBeenCalledTimes(1);
  });

  it("should toggle protection state when /destructive-confirm is invoked", async () => {
    const pi = createMockPi();
    const mod = await import("../../extensions/destructive-confirm/index.js");
    mod.default(pi);

    const ctx = createMockCtx();
    const cmd = (
      pi.registerCommand as ReturnType<typeof vi.fn>
    ).mock.calls.find((c: unknown[]) => c[0] === "destructive-confirm")?.[1];
    const handler = cmd!.handler as (args: string, ctx: ExtensionContext) => Promise<void>;

    // First toggle: enabled -> disabled
    await handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/disabled/i));

    // Reset mocks and toggle again: disabled -> enabled
    vi.clearAllMocks();
    await handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/enabled/i));
  });

  it("should toggle protection state when /dc is invoked (alias)", async () => {
    const pi = createMockPi();
    const mod = await import("../../extensions/destructive-confirm/index.js");
    mod.default(pi);

    const ctx = createMockCtx();
    const cmd = (
      pi.registerCommand as ReturnType<typeof vi.fn>
    ).mock.calls.find((c: unknown[]) => c[0] === "dc")?.[1];
    const handler = cmd!.handler as (args: string, ctx: ExtensionContext) => Promise<void>;

    // First toggle: enabled -> disabled
    await handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/disabled/i));

    // Second toggle: disabled -> enabled
    vi.clearAllMocks();
    await handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/enabled/i));
  });

  it("should show enabled status indicator when enabled", async () => {
    const pi = createMockPi();
    const mod = await import("../../extensions/destructive-confirm/index.js");
    mod.default(pi);

    const ctx = createMockCtx();
    const sessionStartHandler = (
      pi.on as ReturnType<typeof vi.fn>
    ).mock.calls.find((c: unknown[]) => c[0] === "session_start")?.[1];

    await (sessionStartHandler as Function)({}, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "destructive-confirm",
      "🔒 DC",
    );
  });

  it("should show disabled status indicator when toggled off", async () => {
    const pi = createMockPi();
    const mod = await import("../../extensions/destructive-confirm/index.js");
    mod.default(pi);

    const ctx = createMockCtx();
    const cmd = (
      pi.registerCommand as ReturnType<typeof vi.fn>
    ).mock.calls.find((c: unknown[]) => c[0] === "destructive-confirm")?.[1];
    const handler = cmd!.handler as (args: string, ctx: ExtensionContext) => Promise<void>;

    // Toggle from enabled to disabled
    await handler("", ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "destructive-confirm",
      "🔓 DC",
    );
  });

  it("should update footer status after toggling back to enabled", async () => {
    const pi = createMockPi();
    const mod = await import("../../extensions/destructive-confirm/index.js");
    mod.default(pi);

    const ctx = createMockCtx();
    const cmd = (
      pi.registerCommand as ReturnType<typeof vi.fn>
    ).mock.calls.find((c: unknown[]) => c[0] === "destructive-confirm")?.[1];
    const handler = cmd!.handler as (args: string, ctx: ExtensionContext) => Promise<void>;

    // Toggle: enabled -> disabled
    await handler("", ctx);
    vi.clearAllMocks();

    // Toggle: disabled -> enabled
    await handler("", ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "destructive-confirm",
      "🔒 DC",
    );
  });
});
