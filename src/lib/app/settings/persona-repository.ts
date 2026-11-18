import {
	emptyPersonaSettings,
	parsePersonaSettings,
	personaSessionKey,
	resolvePersona,
	type PersonaSettings
} from './personas.js';

export const PERSONA_SETTINGS_KEY = 'helia:persona-settings';
export const PERSONA_SETTINGS_CHANGED = 'helia:persona-settings-changed';
const MAX_DOCUMENT_CHARS = 4 * 1024 * 1024;

/** Player profile data, separate from creator content and authoritative game state. */
export function loadPersonaSettings(): PersonaSettings {
	try {
		const raw = localStorage.getItem(PERSONA_SETTINGS_KEY);
		if (raw === null) {
			return emptyPersonaSettings();
		}
		if (raw.length > MAX_DOCUMENT_CHARS) {
			throw new Error('Too large');
		}
		return parsePersonaSettings(JSON.parse(raw));
	} catch {
		throw new Error('페르소나 설정을 불러오지 못했어요. 저장소를 확인하고 다시 시도해주세요.');
	}
}
export function savePersonaSettings(value: PersonaSettings): PersonaSettings {
	const settings = parsePersonaSettings(value);
	const document = JSON.stringify(settings);
	if (document.length > MAX_DOCUMENT_CHARS) {
		throw new Error('페르소나 설정이 너무 커요. 설명을 줄여주세요.');
	}
	try {
		localStorage.setItem(PERSONA_SETTINGS_KEY, document);
	} catch {
		throw new Error('페르소나를 저장하지 못했어요. 입력 내용은 유지되니 다시 시도해주세요.');
	}
	if (typeof window !== 'undefined') {
		window.dispatchEvent(new Event(PERSONA_SETTINGS_CHANGED));
	}
	return settings;
}
/** Re-read before changing one item so other sessions' bindings are preserved. */
export function updatePersonaSettings(change: (settings: PersonaSettings) => PersonaSettings) {
	return savePersonaSettings(change(loadPersonaSettings()));
}
export function loadSessionPersona(gameId: string, sessionId: string) {
	return resolvePersona(loadPersonaSettings(), personaSessionKey(gameId, sessionId));
}
