import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { importPromptPreset } from '#lib/games/ai/prompts.js';

import {
	PROMPT_SETTINGS_KEY,
	loadPromptSettings,
	savePromptSettings,
	loadSelectedPromptConfig
} from './prompt-repository.js';
import {
	emptyPromptSettings,
	parsePromptSettings,
	upsertPromptPreset,
	removePromptPreset,
	selectPromptPreset
} from './prompts.js';

let stored: Map<string, string>;
beforeEach(() => {
	stored = new Map();
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => stored.get(key) ?? null,
		setItem: (key: string, value: string) => stored.set(key, value)
	});
});
afterEach(() => vi.unstubAllGlobals());

describe('player-owned prompt settings', () => {
	it('restores the selected preset independently from model metadata and game content', () => {
		expect(loadPromptSettings()).toEqual(emptyPromptSettings());
		let settings = upsertPromptPreset(emptyPromptSettings(), {
			id: 'alternate',
			name: 'Alternate',
			config: importPromptPreset({ mainPrompt: 'Player instructions', maxResponse: 256 })
		});
		settings = selectPromptPreset(settings, 'alternate');
		savePromptSettings(settings);
		expect(loadPromptSettings()).toEqual(settings);
		const captured = loadSelectedPromptConfig();
		savePromptSettings(selectPromptPreset(settings, 'default'));
		expect(captured.promptTemplate[0].text).toBe('Player instructions');
		expect(loadSelectedPromptConfig().promptTemplate[0].text).toBe('');
		expect([...stored.keys()]).toEqual([PROMPT_SETTINGS_KEY]);
	});
	it('rebuilds known fields and excludes credentials and game-owned lorebook from presets', () => {
		const config = {
			...emptyPromptSettings().presets[0].config,
			apiKey: 'not-a-key',
			lorebook: [{ keys: [], content: 'Game lore' }]
		};
		const input = {
			...emptyPromptSettings(),
			presets: [{ id: 'default', name: ' Default ', config }],
			secret: 'not-a-key'
		};
		savePromptSettings(input);
		expect(loadPromptSettings().presets[0].name).toBe('Default');
		expect(stored.get(PROMPT_SETTINGS_KEY)).not.toContain('not-a-key');
		expect(stored.get(PROMPT_SETTINGS_KEY)).not.toContain('Game lore');
	});
	it('selects a surviving preset after deletion and rejects deleting the final one', () => {
		let settings = upsertPromptPreset(emptyPromptSettings(), {
			id: 'other',
			name: 'Other',
			config: importPromptPreset({})
		});
		settings = removePromptPreset(settings, 'default');
		expect(settings.selectedPresetId).toBe('other');
		expect(() => removePromptPreset(settings, 'other')).toThrow();
		expect(() => selectPromptPreset(settings, 'missing')).toThrow();
		expect(() =>
			parsePromptSettings({ ...settings, presets: [...settings.presets, ...settings.presets] })
		).toThrow('중복');
	});
	it('preserves corrupt data and reports blocked reads and failed writes', () => {
		stored.set(PROMPT_SETTINGS_KEY, 'broken');
		expect(() => loadPromptSettings()).toThrow('불러오지');
		expect(stored.get(PROMPT_SETTINGS_KEY)).toBe('broken');
		vi.stubGlobal('localStorage', {
			getItem() {
				throw Error('blocked');
			},
			setItem() {
				throw Error('quota');
			}
		});
		expect(() => loadPromptSettings()).toThrow('불러오지');
		expect(() => savePromptSettings(emptyPromptSettings())).toThrow('저장하지');
	});
});
