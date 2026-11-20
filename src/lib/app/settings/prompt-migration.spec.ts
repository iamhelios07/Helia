import { describe, expect, it } from 'vitest';

import { renderCBS } from '#lib/games/ai/cbs/index.js';
import { parsePromptConfig } from '#lib/games/ai/prompts.js';

import { migratePromptCBS } from './prompt-migration.js';

describe('preset CBS migration', () => {
	it('migrates every template-bearing field without changing metadata, toggle text or the source', () => {
		const old = '{{#if_pure 1}}Text{{/if_pure}}';
		const config = parsePromptConfig({
			toggles: 'note=Note=text',
			toggleValues: { note: old },
			promptTemplate: [
				{ type: 'plain', name: old, text: old, innerFormat: old, defaultText: old, enabled: false }
			],
			promptSettings: { postEndInnerFormat: old, assistantPrefill: old }
		});
		const migrated = migratePromptCBS(config);
		expect(migrated.migrated).toBe(5);
		expect(config.promptTemplate[0].text).toBe(old);
		expect(migrated.config.toggleValues.note).toBe(old);
		expect(migrated.config.promptTemplate[0].name).toBe(old);
		expect(migrated.config.promptTemplate[0].enabled).toBe(false);
		const block = migrated.config.promptTemplate[0];
		for (const source of [
			block.text!,
			block.innerFormat!,
			block.defaultText!,
			...Object.values(migrated.config.promptSettings).filter(
				(v): v is string => typeof v === 'string'
			)
		]) {
			expect(renderCBS(source, { state: {} })).toBe('Text');
		}
		expect(migratePromptCBS(migrated.config)).toEqual({ config: migrated.config });
	});
	it('locates conversion failures without rewriting the preset or echoing its contents', () => {
		const config = parsePromptConfig({
			promptTemplate: [{ type: 'plain', text: '{{#if 1}}private-content' }]
		});
		expect(() => migratePromptCBS(config)).toThrow('1번 프롬프트 · text: CBS 위치');
		try {
			migratePromptCBS(config);
		} catch (cause) {
			expect((cause as Error).message).not.toContain('private-content');
		}
		expect(config.promptTemplate[0].text).toContain('#if');
	});
});
