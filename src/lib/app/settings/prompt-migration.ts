import type { PromptConfig } from '#lib/games/ai/prompts.js';

import { CBSMigrationError, migrateCBS } from '#lib/games/ai/cbs/migrate.js';

/** Transform only CBS-bearing preset fields. Names, choices and saved toggle input remain data. */
export function migratePromptCBS(
	source: PromptConfig,
	risuCalculations = false
): {
	config: PromptConfig;
	migrated?: number;
} {
	const config = structuredClone(source);
	let changes = 0;
	function migrate(value: string, location: string): string {
		try {
			const result = migrateCBS(value, risuCalculations);
			changes += result.changes;
			return result.text;
		} catch (cause) {
			if (cause instanceof CBSMigrationError) {
				throw new CBSMigrationError(`${location}: ${cause.message}`);
			}
			throw cause;
		}
	}
	for (const [index, block] of config.promptTemplate.entries()) {
		for (const key of ['text', 'innerFormat', 'defaultText'] as const) {
			if (block[key] !== undefined) {
				block[key] = migrate(block[key], `${index + 1}번 프롬프트 · ${key}`);
			}
		}
	}
	for (const key of ['postEndInnerFormat', 'assistantPrefill'] as const) {
		config.promptSettings[key] = migrate(config.promptSettings[key], key);
	}
	return { config, ...(changes ? { migrated: changes } : {}) };
}
