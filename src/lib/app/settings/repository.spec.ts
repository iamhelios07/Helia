import { beforeEach, afterEach, expect, it, vi } from 'vitest';

import { memoryAISettingsTransport } from '#lib/testing/ai-settings.js';

import { emptyAISettings, upsertProvider, upsertModel } from './model.js';
import { AI_SETTINGS_KEY, loadAISettings, saveAISettings } from './repository.js';
import { aiSettingsRequest } from './settings-transport.js';

vi.mock('./settings-transport.js', () => ({ aiSettingsRequest: vi.fn() }));

let stored: Map<string, string>;
const connected = () =>
	upsertModel(
		upsertProvider(emptyAISettings(), {
			id: 'provider',
			name: '연결',
			kind: 'anthropic',
			baseUrl: 'https://example.com'
		}),
		{ id: 'model', name: '모델', providerId: 'provider', modelId: 'model-id' }
	);

beforeEach(() => {
	stored = new Map();
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => stored.get(key) ?? null,
		setItem: (key: string, value: string) => stored.set(key, value),
		removeItem: (key: string) => stored.delete(key)
	});
	vi.mocked(aiSettingsRequest).mockReset().mockImplementation(memoryAISettingsTransport());
});
afterEach(() => vi.unstubAllGlobals());

it('starts empty and restores connections, models and the default without browser storage', async () => {
	const previous = await loadAISettings();
	expect(previous).toEqual(emptyAISettings());
	expect(await saveAISettings(connected(), previous)).toEqual(connected());
	expect(stored.has(AI_SETTINGS_KEY)).toBe(false);
	stored.clear();
	expect(await loadAISettings()).toEqual(connected());
});
it('migrates legacy metadata once, retaining identifiers used by encrypted credentials', async () => {
	stored.set(AI_SETTINGS_KEY, JSON.stringify({ ...connected(), apiKey: 'must-not-migrate' }));
	expect(await loadAISettings()).toEqual(connected());
	expect(stored.has(AI_SETTINGS_KEY)).toBe(false);
	expect(aiSettingsRequest).toHaveBeenCalledWith({ kind: 'initialize', settings: connected() });
	expect(JSON.stringify(vi.mocked(aiSettingsRequest).mock.calls)).not.toContain('must-not-migrate');
});
it('does not overwrite existing host settings with stale or malformed browser settings', async () => {
	vi.mocked(aiSettingsRequest).mockImplementation(memoryAISettingsTransport(connected()));
	stored.set(AI_SETTINGS_KEY, 'not-json');
	expect(await loadAISettings()).toEqual(connected());
	expect(aiSettingsRequest).toHaveBeenCalledTimes(1);
	expect(stored.has(AI_SETTINGS_KEY)).toBe(false);
});
it('does not resurrect removed connections from another browser legacy copy', async () => {
	const settings = await saveAISettings(connected());
	await saveAISettings(emptyAISettings(), settings);
	stored.set(AI_SETTINGS_KEY, JSON.stringify(connected()));
	expect(await loadAISettings()).toEqual(emptyAISettings());
});
it('strips unknown credential fields from server writes', async () => {
	await saveAISettings({ ...emptyAISettings(), ...{ apiKey: 'must-not-save' } });
	expect(aiSettingsRequest).toHaveBeenLastCalledWith({
		kind: 'write',
		settings: emptyAISettings(),
		revision: 1
	});
});
it('retains legacy data when its format is unreadable, without initializing the host', async () => {
	stored.set(AI_SETTINGS_KEY, 'not-json');
	await expect(loadAISettings()).rejects.toThrow('불러오지 못했어요');
	expect(stored.get(AI_SETTINGS_KEY)).toBe('not-json');
	expect(aiSettingsRequest).toHaveBeenCalledTimes(1);
});
it('retains legacy data if migration fails and retries on the next load', async () => {
	stored.set(AI_SETTINGS_KEY, JSON.stringify(connected()));
	vi.mocked(aiSettingsRequest)
		.mockResolvedValueOnce({ settings: null, revision: 0 })
		.mockRejectedValueOnce(new Error('서버를 사용할 수 없어요.'));
	await expect(loadAISettings()).rejects.toThrow('서버를 사용할 수 없어요');
	expect(stored.get(AI_SETTINGS_KEY)).toBe(JSON.stringify(connected()));
	expect(await loadAISettings()).toEqual(connected());
});
it('loads and saves on the host when browser storage is blocked', async () => {
	vi.stubGlobal('localStorage', {
		getItem() {
			throw new Error('blocked');
		},
		removeItem() {
			throw new Error('blocked');
		}
	});
	expect(await loadAISettings()).toEqual(emptyAISettings());
	expect(await saveAISettings(connected())).toEqual(connected());
	expect(await loadAISettings()).toEqual(connected());
});
it('rejects stale saves rather than overwriting changes from another tab', async () => {
	const first = await loadAISettings();
	const second = await loadAISettings();
	await saveAISettings(connected(), first);
	await expect(saveAISettings(emptyAISettings(), second)).rejects.toThrow('다른 창');
	expect(await loadAISettings()).toEqual(connected());
});
it('requires a previously loaded snapshot when an explicit base is supplied', async () => {
	await expect(saveAISettings(connected(), emptyAISettings())).rejects.toThrow('다시 불러온 후');
	expect(aiSettingsRequest).not.toHaveBeenCalled();
});
it('does not silently fall back to browser settings on a host read failure', async () => {
	stored.set(AI_SETTINGS_KEY, JSON.stringify(connected()));
	vi.mocked(aiSettingsRequest).mockRejectedValueOnce(new Error('서버 연결 실패'));
	await expect(loadAISettings()).rejects.toThrow('서버 연결 실패');
	expect(stored.get(AI_SETTINGS_KEY)).toBe(JSON.stringify(connected()));
});
it('returns the existing host state if another browser wins initialization', async () => {
	stored.set(AI_SETTINGS_KEY, JSON.stringify(emptyAISettings()));
	vi.mocked(aiSettingsRequest)
		.mockResolvedValueOnce({ settings: null, revision: 0 })
		.mockResolvedValueOnce({ settings: connected(), revision: 1 });
	expect(await loadAISettings()).toEqual(connected());
	expect(stored.has(AI_SETTINGS_KEY)).toBe(false);
});
