import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { emptyAISettings, upsertProvider } from './model.js';
import { AI_SETTINGS_KEY, loadAISettings, saveAISettings } from './repository.js';

let stored: Map<string, string>;
beforeEach(() => {
	stored = new Map();
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => stored.get(key) ?? null,
		setItem: (key: string, value: string) => stored.set(key, value)
	});
});
afterEach(() => vi.unstubAllGlobals());

describe('device-local model settings', () => {
	it('starts empty and restores saved provider metadata', () => {
		expect(loadAISettings()).toEqual(emptyAISettings());
		const settings = upsertProvider(emptyAISettings(), {
			id: 'provider',
			name: '연결',
			kind: 'anthropic',
			baseUrl: 'https://example.com'
		});
		expect(saveAISettings(settings)).toEqual(settings);
		expect(loadAISettings()).toEqual(settings);
	});
	it('strips unknown credential fields on write', () => {
		const value = { ...emptyAISettings(), apiKey: 'must-not-save' };
		saveAISettings(value);
		expect(stored.get(AI_SETTINGS_KEY)).toBe(JSON.stringify(emptyAISettings()));
	});
	it('reports corrupt stored settings without resetting or overwriting them', () => {
		stored.set(AI_SETTINGS_KEY, 'not-json');
		expect(() => loadAISettings()).toThrow('불러오지 못했어요');
		expect(stored.get(AI_SETTINGS_KEY)).toBe('not-json');
	});
	it('reports blocked reads and writes instead of claiming persistence succeeded', () => {
		vi.stubGlobal('localStorage', {
			getItem() {
				throw new Error('blocked');
			},
			setItem() {
				throw new Error('quota');
			}
		});
		expect(() => loadAISettings()).toThrow('불러오지 못했어요');
		expect(() => saveAISettings(emptyAISettings())).toThrow('저장하지 못했어요');
	});
});
