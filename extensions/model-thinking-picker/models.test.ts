import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { test } from "node:test";
import lockfile from "proper-lockfile";
import type { Api, Model } from "@earendil-works/pi-ai";
import { buildModelList, resolveLevel, writeDefaults } from "./models.ts";

function createModel(id: string, options: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider: "test",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
		...options,
	};
}

test("uses scoped models and marks the current model", () => {
	const scoped = createModel("scoped");
	const fallback = createModel("fallback");

	assert.deepEqual(buildModelList([scoped], [fallback], scoped), [{ model: scoped, isCurrent: true }]);
	assert.deepEqual(buildModelList([scoped], [fallback], undefined), [{ model: scoped, isCurrent: false }]);
});

test("uses all models when no scoped model exists", () => {
	const fallback = createModel("fallback");

	assert.deepEqual(buildModelList([], [fallback], undefined), [{ model: fallback, isCurrent: false }]);
});

test("keeps supported thinking levels and clamps unsupported levels", () => {
	const limited = createModel("limited", {
		thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null },
	});
	const nonReasoning = createModel("plain", { reasoning: false });

	assert.equal(resolveLevel(limited, "low"), "low");
	assert.equal(resolveLevel(limited, "medium"), "high");
	assert.equal(resolveLevel(nonReasoning, "high"), "off");
});

test("updates only the model defaults", () => {
	const directory = mkdtempSync(join(tmpdir(), "model-thinking-picker-"));
	const settingsPath = join(directory, "settings.json");
	const model = createModel("next", { provider: "next-provider" });
	writeFileSync(settingsPath, '{\n\t"keep": true,\n\t"defaultModel": "old"\n}\n');

	try {
		writeDefaults(model, "high", settingsPath);

		assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
			keep: true,
			defaultModel: "next",
			defaultProvider: "next-provider",
			defaultThinkingLevel: "high",
		});
		assert.match(readFileSync(settingsPath, "utf8"), /^\{\n\t/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("does not write settings while Pi holds the settings lock", async () => {
	const directory = mkdtempSync(join(tmpdir(), "model-thinking-picker-"));
	const settingsPath = join(directory, "settings.json");
	const model = createModel("next", { provider: "next-provider" });
	writeFileSync(settingsPath, '{\n\t"defaultModel": "old"\n}\n');
	const release = lockfile.lockSync(settingsPath, { realpath: false });
	const script = [
		`import { writeDefaults } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "models.ts")).href)};`,
		`process.send?.("ready");`,
		`writeDefaults(${JSON.stringify(model)}, "high", ${JSON.stringify(settingsPath)});`,
	].join("\n");
	const writer = spawn(process.execPath, ["--eval", script], { cwd: process.cwd(), stdio: ["ignore", "ignore", "ignore", "ipc"] });
	const ready = once(writer, "message");

	try {
		await ready;
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).defaultModel, "old");
	} finally {
		release();
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).defaultModel, "next");
		writer.kill();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("throws when the settings file does not exist", () => {
	assert.throws(() => writeDefaults(createModel("next"), "high", join(tmpdir(), "missing-settings.json")));
});
