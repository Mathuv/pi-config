import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, Key, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import { resolveLevel, type ModelEntry } from "./models.ts";

export type PickerResult = { model: Model<Api>; level: ModelThinkingLevel } | null;

interface ThemeLike {
	fg(color: string, text: string): string;
}

interface KeybindingsLike {
	matches(data: string, action: string): boolean;
}

export class ModelThinkingPicker extends Container {
	private readonly searchInput = new Input();
	private readonly listContainer = new Container();
	private readonly thinkingText = new Text();
	private filteredEntries: ModelEntry[];
	private highlightIndex: number;
	private pendingLevel: ModelThinkingLevel;

	constructor(
		private readonly tui: Pick<TUI, "requestRender">,
		private readonly entries: ModelEntry[],
		currentLevel: ModelThinkingLevel,
		private readonly theme: ThemeLike,
		private readonly keybindings: KeybindingsLike,
		private readonly done: (result: PickerResult) => void,
	) {
		super();
		this.filteredEntries = entries;
		this.highlightIndex = Math.max(0, entries.findIndex((entry) => entry.isCurrent));
		this.pendingLevel = currentLevel;

		this.addChild(new DynamicBorder((text) => this.theme.fg("borderMuted", text)));
		this.addChild(new Text(this.theme.fg("accent", "Select model"), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(this.thinkingText);
		this.addChild(new Text(this.theme.fg("muted", "↑↓ move · ←→ thinking · enter apply · esc cancel"), 0, 0));
		this.addChild(new DynamicBorder((text) => this.theme.fg("borderMuted", text)));

		this.updateContent();
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done(null);
			return;
		}

		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const selected = this.selectedEntry();
			if (selected) this.done({ model: selected.model, level: this.pendingLevel });
			return;
		}

		if (this.keybindings.matches(data, "tui.select.up") || this.keybindings.matches(data, "tui.select.down")) {
			if (this.filteredEntries.length === 0) return;
			const direction = this.keybindings.matches(data, "tui.select.up") ? -1 : 1;
			this.highlightIndex = (this.highlightIndex + direction + this.filteredEntries.length) % this.filteredEntries.length;
			this.pendingLevel = resolveLevel(this.selectedEntry()!.model, this.pendingLevel);
			this.updateContent();
			return;
		}

		if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
			const selected = this.selectedEntry();
			if (!selected) return;
			const levels = getSupportedThinkingLevels(selected.model);
			if (levels.length === 1) return;
			const index = levels.indexOf(this.pendingLevel);
			const direction = matchesKey(data, Key.left) ? -1 : 1;
			this.pendingLevel = levels[(index + direction + levels.length) % levels.length]!;
			this.updateContent();
			return;
		}

		this.searchInput.handleInput(data);
		this.filteredEntries = fuzzyFilter(this.entries, this.searchInput.getValue(), (entry) =>
			`${entry.model.provider}/${entry.model.id} ${entry.model.name}`,
		);
		this.highlightIndex = 0;
		this.updateContent();
	}

	private selectedEntry(): ModelEntry | undefined {
		return this.filteredEntries[this.highlightIndex];
	}

	private updateContent(): void {
		this.listContainer.clear();
		if (this.filteredEntries.length === 0) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", "  no matches"), 0, 0));
		} else {
			for (const [index, entry] of this.filteredEntries.entries()) {
				const prefix = index === this.highlightIndex ? "→ " : "  ";
				const label = `[${entry.model.provider}] ${entry.model.id}`;
				const model = index === this.highlightIndex ? this.theme.fg("accent", label) : label;
				const current = entry.isCurrent ? this.theme.fg("success", " ✓") : "";
				this.listContainer.addChild(new Text(`${prefix}${model}${current}`, 0, 0));
			}
		}

		const selected = this.selectedEntry();
		const levels = selected ? getSupportedThinkingLevels(selected.model) : ["off"];
		const level = selected ? this.pendingLevel : "off";
		const indicator = levels.length === 1 ? this.theme.fg("muted", "off") : this.theme.fg("accent", `◂ ${level} ▸`);
		this.thinkingText.setText(`${this.theme.fg("muted", "Thinking: ")}${indicator}`);
		this.tui.requestRender();
	}
}
