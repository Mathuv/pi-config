// Model Thinking Picker.
// alt+p (fallback ctrl+alt+p) opens a model and thinking-level picker.
// Default macOS Terminal.app sends "π" for Option+P.
// Use ctrl+alt+p there, or enable Option-as-Meta.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as os from "node:os";
import * as path from "node:path";
import { buildModelList, writeDefaults } from "./models.ts";
import { ModelThinkingPicker, type PickerResult } from "./picker.ts";

let pickerOpen = false;

export default function activate(pi: ExtensionAPI): void {
	const open = async (ctx: ExtensionContext): Promise<void> => {
		if (ctx.mode !== "tui" || !ctx.hasUI || pickerOpen) return;

		pickerOpen = true;
		try {
			const entries = buildModelList(
				ctx.scopedModels.map(({ model }) => model),
				ctx.modelRegistry.getAvailable(),
				ctx.model,
			);
			const result = await ctx.ui.custom<PickerResult>((tui, theme, keybindings, done) =>
				new ModelThinkingPicker(tui, entries, pi.getThinkingLevel(), theme, keybindings, done),
			);
			if (!result) return;

			const applied = await pi.setModel(result.model);
			if (!applied) {
				ctx.ui.notify(`No API key for ${result.model.provider}`, "warning");
				return;
			}

			pi.setThinkingLevel(result.level);
			try {
				writeDefaults(result.model, result.level, path.join(os.homedir(), ".pi", "agent", "settings.json"));
			} catch {
				ctx.ui.notify("Model applied. The settings.json write failed.", "warning");
			}
		} finally {
			pickerOpen = false;
		}
	};

	pi.registerShortcut("alt+p", {
		description: "Open the model and thinking picker",
		handler: open,
	});
	pi.registerShortcut("ctrl+alt+p", {
		description: "Open the model and thinking picker (fallback)",
		handler: open,
	});
}
