import { clampThinkingLevel, getSupportedThinkingLevels, modelsAreEqual } from "@earendil-works/pi-ai";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import lockfile from "proper-lockfile";

export interface ModelEntry {
	model: Model<Api>;
	isCurrent: boolean;
}

export function buildModelList(
	scopedModels: readonly Model<Api>[],
	allModels: readonly Model<Api>[],
	currentModel: Model<Api> | undefined,
): ModelEntry[] {
	const source =
		scopedModels.length > 0
			? scopedModels
			: [...allModels].sort((a, b) => {
				const aIsCurrent = currentModel !== undefined && modelsAreEqual(currentModel, a);
				const bIsCurrent = currentModel !== undefined && modelsAreEqual(currentModel, b);
				if (aIsCurrent && !bIsCurrent) return -1;
				if (!aIsCurrent && bIsCurrent) return 1;
				return a.provider.localeCompare(b.provider);
			});
	return source.map((model) => ({
		model,
		isCurrent: currentModel !== undefined && modelsAreEqual(model, currentModel),
	}));
}

export function resolveLevel(model: Model<Api>, wanted: ModelThinkingLevel): ModelThinkingLevel {
	const supported = getSupportedThinkingLevels(model);
	return supported.includes(wanted) ? wanted : clampThinkingLevel(model, wanted);
}

function acquireSettingsLock(settingsPath: string): () => void {
	const maxAttempts = 10;
	const delayMs = 20;
	let lastError: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			return lockfile.lockSync(settingsPath, { realpath: false });
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
			if (code !== "ELOCKED" || attempt === maxAttempts) {
				throw error;
			}
			lastError = error;
			const start = Date.now();
			while (Date.now() - start < delayMs) {}
		}
	}

	throw lastError;
}

export function writeDefaults(model: Model<Api>, level: ModelThinkingLevel, settingsPath: string): void {
	const release = acquireSettingsLock(settingsPath);
	try {
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
		settings.defaultProvider = model.provider;
		settings.defaultModel = model.id;
		settings.defaultThinkingLevel = level;
		fs.writeFileSync(settingsPath, JSON.stringify(settings, null, "\t") + "\n");
	} finally {
		release();
	}
}
