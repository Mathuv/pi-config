import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { buildModelList, resolveLevel, writeDefaults } from "./models.ts";

function createModel(id: string, options: Partial<Model> = {}): Model {
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
	const limited = createModel("limited", { thinkingLevelMap: { off: null, low: "low", high: "high" } });
	const nonReasoning = createModel("plain", { reasoning: false });

	assert.equal(resolveLevel(limited, "low"), "low");
	assert.equal(resolveLevel(limited, "medium"), "low");
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

test("throws when the settings file does not exist", () => {
	assert.throws(() => writeDefaults(createModel("next"), "high", join(tmpdir(), "missing-settings.json")));
});
