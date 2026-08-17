import { clampThinkingLevel, getSupportedThinkingLevels, modelsAreEqual } from "@earendil-works/pi-ai";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import * as fs from "node:fs";

export interface ModelEntry {
	model: Model;
	isCurrent: boolean;
}

export function buildModelList(scopedModels: readonly Model[], allModels: readonly Model[], currentModel: Model | undefined): ModelEntry[] {
	const source = scopedModels.length > 0 ? scopedModels : allModels;
	return source.map((model) => ({
		model,
		isCurrent: currentModel !== undefined && modelsAreEqual(model, currentModel),
	}));
}

export function resolveLevel(model: Model, wanted: ModelThinkingLevel): ModelThinkingLevel {
	const supported = getSupportedThinkingLevels(model);
	return supported.includes(wanted) ? wanted : clampThinkingLevel(model, wanted);
}

export function writeDefaults(model: Model, level: ModelThinkingLevel, settingsPath: string): void {
	const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	settings.defaultProvider = model.provider;
	settings.defaultModel = model.id;
	settings.defaultThinkingLevel = level;
	fs.writeFileSync(settingsPath, JSON.stringify(settings, null, "\t") + "\n");
}
