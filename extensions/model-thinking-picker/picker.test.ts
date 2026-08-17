import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { ModelThinkingPicker, type PickerResult } from "./picker.ts";
import { buildModelList, type ModelEntry } from "./models.ts";

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

test("the list matches Pi's model row format and detail line", () => {
	const styledTheme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	};
	const tui = { requestRender() {} };
	const picker = new ModelThinkingPicker(
		tui as never,
		entries(),
		"medium",
		styledTheme,
		{ matches: () => false },
		() => {},
	);

	const rendered = picker.render(200).join("\n");

	assert.match(rendered, /  alpha <muted>\[test\]<\/muted>/);
	assert.match(rendered, /<accent>→ <\/accent><accent>beta<\/accent> <muted>\[test\]<\/muted><success> ✓<\/success>/);
	assert.match(rendered, /<muted>  Model Name: beta<\/muted>/);
});

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

test("the initial selection clamps an unsupported session level", () => {
	const plain = createModel("plain", { reasoning: false });
	const active = createModel("active");
	const entries = buildModelList([plain], [], active);
	const { picker, results } = createPicker(entries, "high");

	assert.match(picker.render(80).join("\n"), /Thinking: off/);
	picker.handleInput("tui.select.confirm");

	assert.deepEqual(results, [{ model: plain, level: "off" }]);
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

	assert.match(filtered, /→ alpha \[test\]/);
	assert.doesNotMatch(filtered, /beta \[test\]/);
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

	assert.ok(rendered.indexOf("openai/gpt-5 [openai]") < rendered.indexOf("gpt-5 [openrouter]"));
});

test("typing keeps the built-in current-first provider order for equal fuzzy scores", () => {
	const zebra = createModel("foo", { provider: "zebra" });
	const alpha = createModel("foo", { provider: "alpha" });
	const current = createModel("foo", { provider: "kappa" });
	const { picker } = createPicker(
		buildModelList([], [zebra, alpha, current], current),
	);

	picker.handleInput("foo");
	const rendered = picker.render(80).join("\n");

	assert.ok(rendered.indexOf("foo [kappa]") < rendered.indexOf("foo [alpha]"));
	assert.ok(rendered.indexOf("foo [alpha]") < rendered.indexOf("foo [zebra]"));
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

test("the list uses Pi's ten-row scroll window and counter", () => {
	const entries = Array.from({ length: 520 }, (_, index) => ({
		model: createModel(`model-${String(index).padStart(3, "0")}`),
		isCurrent: index === 0,
	}));
	const { picker } = createPicker(entries);

	const initial = picker.render(80).join("\n");
	assert.equal((initial.match(/model-\d+ \[test\]/g) ?? []).length, 10);
	assert.match(initial, /→ model-000 \[test\]/);
	assert.match(initial, /\(1\/520\)/);
	assert.doesNotMatch(initial, /model-010/);

	for (let index = 0; index < 6; index++) picker.handleInput("tui.select.down");
	const scrolled = picker.render(80).join("\n");
	assert.match(scrolled, /  model-001 \[test\]/);
	assert.match(scrolled, /→ model-006 \[test\]/);
	assert.match(scrolled, /  model-010 \[test\]/);
	assert.match(scrolled, /\(7\/520\)/);
	assert.doesNotMatch(scrolled, /model-000|model-011/);

	picker.handleInput("model-5");
	const filtered = picker.render(80).join("\n");
	assert.match(filtered, /→ model-500 \[test\]/);
	assert.match(filtered, /\(1\/115\)/);
	assert.doesNotMatch(filtered, /model-000/);
});

test("the picker forwards focus to the search input", () => {
	const { picker } = createPicker(entries());
	const focusable = picker as unknown as { focused: boolean; searchInput: { focused: boolean } };

	assert.equal(focusable.focused, false);
	focusable.focused = true;
	assert.equal(focusable.searchInput.focused, true);
	focusable.focused = false;
	assert.equal(focusable.searchInput.focused, false);
});

test("the window boundaries and empty result counter match Pi", () => {
	for (const { count, moves, expectedRows, counter } of [
		{ count: 10, moves: 0, expectedRows: 10, counter: undefined },
		{ count: 11, moves: 0, expectedRows: 10, counter: "(1/11)" },
		{ count: 11, moves: 10, expectedRows: 10, counter: "(11/11)" },
		{ count: 11, moves: 11, expectedRows: 10, counter: "(1/11)" },
	]) {
		const models = Array.from({ length: count }, (_, index) => ({
			model: createModel(`boundary-${String(index).padStart(2, "0")}`),
			isCurrent: index === 0,
		}));
		const { picker } = createPicker(models);
		for (let index = 0; index < moves; index += 1) picker.handleInput("tui.select.down");
		const rendered = picker.render(80).join("\n");

		assert.equal((rendered.match(/boundary-\d+ \[test\]/g) ?? []).length, expectedRows);
		if (counter) assert.ok(rendered.includes(counter));
		else assert.doesNotMatch(rendered, /\(\d+\/\d+\)/);
	}

	const { picker } = createPicker(entries());
	picker.handleInput("zzz");
	assert.doesNotMatch(picker.render(80).join("\n"), /\(\d+\/0\)/);
});

test("an unselected current model keeps its success check", () => {
	const { picker } = createPicker(entries());
	picker.handleInput("tui.select.down");

	assert.match(picker.render(80).join("\n"), /  beta \[test\] ✓/);
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
