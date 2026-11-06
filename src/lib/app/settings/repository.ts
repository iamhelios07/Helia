import { emptyAISettings, parseAISettings, type AISettings } from './model.js';

export const AI_SETTINGS_KEY = 'helia:ai-settings';

/** Device-local provider/model metadata only. Credentials never belong in this document. */
export function loadAISettings(): AISettings {
	try {
		const raw = localStorage.getItem(AI_SETTINGS_KEY);
		return raw === null ? emptyAISettings() : parseAISettings(JSON.parse(raw));
	} catch {
		throw new Error('모델 설정을 불러오지 못했어요. 저장소를 확인하고 다시 시도해주세요.');
	}
}

export function saveAISettings(value: AISettings): AISettings {
	const settings = parseAISettings(value);
	try {
		localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(settings));
	} catch {
		throw new Error('모델 설정을 저장하지 못했어요. 입력 내용은 유지되니 다시 시도해주세요.');
	}
	return settings;
}
