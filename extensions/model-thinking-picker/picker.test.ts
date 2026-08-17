import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { ModelThinkingPicker, type PickerResult } from "./picker.ts";
import type { ModelEntry } from "./models.ts";

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

function createPicker(entries: ModelEntry[], level: ModelThinkingLevel = "medium") {
	const results: PickerResult[] = [];
	const tui = { requestRender() {} };
	const theme = { fg: (_color: string, text: string) => text };
	const keybindings = {
		matches(data: string, action: string) {
			return data === action;
		},
	};
	const picker = new ModelThinkingPicker(tui as never, entries, level, theme as never, keybindings, (result) => {
		results.push(result);
	});
	return { picker, results };
}

function entries(): ModelEntry[] {
	return [
		{ model: createModel("alpha"), isCurrent: false },
		{ model: createModel("beta"), isCurrent: true },
		{
			model: createModel("plain", { reasoning: false }),
			isCurrent: false,
		},
	];
}

test("Escape cancels the picker", () => {
	const { picker, results } = createPicker(entries());

	picker.handleInput("tui.select.cancel");

	assert.deepEqual(results, [null]);
});

test("Enter resolves the highlighted model and pending level", () => {
	const { picker, results } = createPicker(entries());

	picker.handleInput("tui.select.confirm");

	assert.deepEqual(results, [{ model: entries()[1]!.model, level: "medium" }]);
});

test("Enter does nothing when the filter has no matches", () => {
	const { picker, results } = createPicker(entries());
	picker.handleInput("zzz");

	picker.handleInput("tui.select.confirm");

	assert.deepEqual(results, []);
});

test("typing filters the list, resets the highlight, and renders no matches", () => {
	const { picker } = createPicker(entries());

	picker.handleInput("alpha");
	const filtered = picker.render(80).join("\n");
	picker.handleInput("zzz");
	const empty = picker.render(80).join("\n");

	assert.match(filtered, /→ \[test\] alpha/);
	assert.doesNotMatch(filtered, /\[test\] beta/);
	assert.match(empty, /no matches/);
});

test("typing preserves the built-in model search order", () => {
	const openRouter = createModel("gpt-5", { provider: "openrouter" });
	const openAI = createModel("openai/gpt-5", { provider: "openai" });
	const { picker } = createPicker([
		{ model: openRouter, isCurrent: false },
		{ model: openAI, isCurrent: true },
	]);

	picker.handleInput("gpt");
	const rendered = picker.render(80).join("\n");

	assert.ok(rendered.indexOf("[openai] openai/gpt-5") < rendered.indexOf("[openrouter] gpt-5"));
});

test("typing clamps the pending level for the first filtered model", () => {
	const models = entries();
	const { picker, results } = createPicker(models);

	picker.handleInput("plain");
	picker.handleInput("tui.select.confirm");

	assert.deepEqual(results, [{ model: models[2]!.model, level: "off" }]);
});

test("Up and Down wrap through filtered models", () => {
	const models = entries();
	const { picker, results } = createPicker(models);

	picker.handleInput("tui.select.up");
	picker.handleInput("tui.select.up");
	picker.handleInput("tui.select.confirm");
	picker.handleInput("tui.select.down");
	picker.handleInput("tui.select.confirm");

	assert.deepEqual(results, [
		{ model: models[2]!.model, level: "off" },
		{ model: models[0]!.model, level: "off" },
	]);
});

test("Left and Right cycle only supported thinking levels", () => {
	const model = createModel("limited", {
		thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
	});
	const { picker, results } = createPicker([{ model, isCurrent: true }], "medium");

	picker.handleInput("\u001b[C");
	picker.handleInput("tui.select.confirm");
	picker.handleInput("\u001b[D");
	picker.handleInput("tui.select.confirm");

	assert.deepEqual(results, [
		{ model, level: "high" },
		{ model, level: "medium" },
	]);
});

test("Left and Right ignore a model that supports only off", () => {
	const plain = createModel("plain", { reasoning: false });
	const { picker, results } = createPicker([{ model: plain, isCurrent: true }], "off");

	picker.handleInput("\u001b[C");
	picker.handleInput("\u001b[D");
	picker.handleInput("tui.select.confirm");

	assert.deepEqual(results, [{ model: plain, level: "off" }]);
	assert.doesNotMatch(picker.render(80).join("\n"), /◂|▸/);
});

test("a singleton non-off level renders its pending level", () => {
	const highOnly = createModel("high-only", {
		thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
	});
	const { picker } = createPicker([{ model: highOnly, isCurrent: true }], "high");

	const rendered = picker.render(80).join("\n");

	assert.match(rendered, /Thinking: ◂ high ▸/);
});

test("a highlight move carries a level over, then clamps it for the next model", () => {
	const highOnly = createModel("high-only", {
		thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
	});
	const { picker, results } = createPicker(
		[
			{ model: createModel("current"), isCurrent: true },
			{ model: highOnly, isCurrent: false },
		],
		"medium",
	);

	picker.handleInput("tui.select.down");
	picker.handleInput("tui.select.confirm");

	assert.deepEqual(results, [{ model: highOnly, level: "high" }]);
});
