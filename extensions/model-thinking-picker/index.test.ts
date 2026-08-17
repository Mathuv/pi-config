import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import activate from "./index.ts";

type Handler = (ctx: object) => Promise<void>;

function createExtension(setModelResult: boolean = true) {
	const handlers = new Map<string, Handler>();
	const levels: string[] = [];
	activate({
		registerShortcut(key: string, shortcut: { handler: Handler }) {
			handlers.set(key, shortcut.handler);
		},
		getThinkingLevel: () => "medium",
		setModel: async () => setModelResult,
		setThinkingLevel: (level: string) => levels.push(level),
	} as never);
	return { handlers, levels };
}

test("the picker registers the primary and fallback shortcuts", () => {
	const { handlers } = createExtension();

	assert.deepEqual([...handlers.keys()], ["alt+p", "ctrl+alt+p"]);
});

test("the shortcut guards, applies atomically, persists defaults, and resets after failures", () => {
	const home = mkdtempSync(path.join(os.tmpdir(), "model-thinking-picker-"));
	const indexUrl = new URL("./index.ts", import.meta.url).href;
	const program = `
		import assert from "node:assert/strict";
		import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
		import * as os from "node:os";
		import * as path from "node:path";
		import activate from ${JSON.stringify(indexUrl)};
		const model = { id: "picked", name: "picked", api: "openai-responses", provider: "test", baseUrl: "https://example.test", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1 };
		const selection = { model, level: "high" };
		const createExtension = (setModelResult = true) => {
			const handlers = new Map(); const levels = [];
			activate({ registerShortcut: (key, shortcut) => handlers.set(key, shortcut.handler), getThinkingLevel: () => "medium", setModel: async () => setModelResult, setThinkingLevel: (level) => levels.push(level) });
			return { handlers, levels };
		};
		const createContext = (result, calls, notifications) => ({ mode: "tui", hasUI: true, model, scopedModels: [{ model }], modelRegistry: { getAvailable: () => [model] }, ui: { custom: async () => { calls.value += 1; return result; }, notify: (message) => notifications.push(message) } });
		const calls = { value: 0 }; const notifications = []; const extension = createExtension(); const handler = extension.handlers.get("alt+p");
		await handler({ mode: "rpc", hasUI: true }); await handler({ mode: "tui", hasUI: false }); assert.equal(calls.value, 0);
		const noKey = createExtension(false); await noKey.handlers.get("alt+p")(createContext(selection, calls, notifications)); assert.deepEqual(noKey.levels, []); assert.match(notifications.pop(), /No API key/);
		const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json"); mkdirSync(path.dirname(settingsPath), { recursive: true }); writeFileSync(settingsPath, "{ invalid");
		await handler(createContext(selection, calls, notifications)); assert.deepEqual(extension.levels, ["high"]); assert.match(notifications.pop(), /settings\\.json write failed/);
		writeFileSync(settingsPath, "{}\\n"); await handler(createContext(selection, calls, notifications)); assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { defaultProvider: "test", defaultModel: "picked", defaultThinkingLevel: "high" });
		let done; const reentry = createContext(new Promise((resolve) => (done = resolve)), calls, notifications); const first = handler(reentry); await handler(reentry); assert.equal(calls.value, 4); done(null); await first;
	`;
	try {
		execFileSync(process.execPath, ["-e", program], { env: { ...process.env, HOME: home } });
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
