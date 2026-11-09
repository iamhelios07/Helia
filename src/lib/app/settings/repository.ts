import { emptyAISettings, parseAISettings, type AISettings } from './model.js';
import { aiSettingsRequest, type AISettingsSnapshot } from './settings-transport.js';

/** Used only to migrate settings created before host-side persistence. */
export const AI_SETTINGS_KEY = 'helia:ai-settings';
const revisions = new WeakMap<AISettings, number>();

function legacySettings(): AISettings {
	let raw: string | null;
	try {
		raw = localStorage.getItem(AI_SETTINGS_KEY);
	} catch {
		// Host settings must also work when browser storage is unavailable.
		return emptyAISettings();
	}
	try {
		return raw === null ? emptyAISettings() : parseAISettings(JSON.parse(raw));
	} catch {
		throw new Error('기존 모델 설정을 불러오지 못했어요. 브라우저의 설정 데이터를 확인해주세요.');
	}
}

function clearLegacySettings() {
	try {
		localStorage.removeItem(AI_SETTINGS_KEY);
	} catch {
		// Cleanup is optional; an initialized host never imports this copy again.
	}
}

function remember(snapshot: AISettingsSnapshot): AISettings {
	if (snapshot.settings === null) {
		throw new Error('모델 설정을 불러오지 못했어요. 다시 시도해주세요.');
	}
	const settings = parseAISettings(snapshot.settings);
	revisions.set(settings, snapshot.revision);
	return settings;
}

/** The host is authoritative; browser storage is read only for the first migration. */
export async function loadAISettings(): Promise<AISettings> {
	let snapshot = await aiSettingsRequest({ kind: 'read' });
	if (snapshot.settings === null) {
		snapshot = await aiSettingsRequest({ kind: 'initialize', settings: legacySettings() });
	}
	const settings = remember(snapshot);
	clearLegacySettings();
	return settings;
}

export async function saveAISettings(
	value: AISettings,
	previous?: AISettings
): Promise<AISettings> {
	const settings = parseAISettings(value);
	const revision = revisions.get(previous ?? (await loadAISettings()));
	if (revision === undefined) {
		throw new Error('모델 설정을 다시 불러온 후 저장해주세요.');
	}
	return remember(await aiSettingsRequest({ kind: 'write', settings, revision }));
}
