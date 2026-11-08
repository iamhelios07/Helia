import type { PromptConfig } from '#lib/games/ai/prompts.js';

import { emptyPromptSettings, parsePromptSettings, type PromptSettings } from './prompts.js';

export const PROMPT_SETTINGS_KEY = 'helia:prompt-settings';
const MAX_DOCUMENT_CHARS = 4 * 1024 * 1024;

/** Player-owned presets stay in the device profile, outside games and their snapshots. */
export function loadPromptSettings(): PromptSettings {
	try {
		const raw = localStorage.getItem(PROMPT_SETTINGS_KEY);
		if (raw === null) {
			return emptyPromptSettings();
		}
		if (raw.length > MAX_DOCUMENT_CHARS) {
			throw new Error('Too large');
		}
		return parsePromptSettings(JSON.parse(raw));
	} catch {
		throw new Error('프롬프트 설정을 불러오지 못했어요. 저장소를 확인하고 다시 시도해주세요.');
	}
}

export function savePromptSettings(value: PromptSettings): PromptSettings {
	const settings = parsePromptSettings(value);
	const document = JSON.stringify(settings);
	if (document.length > MAX_DOCUMENT_CHARS) {
		throw new Error('프롬프트 설정이 너무 커요. 프리셋이나 본문을 줄여주세요.');
	}
	try {
		localStorage.setItem(PROMPT_SETTINGS_KEY, document);
	} catch {
		throw new Error('프롬프트 설정을 저장하지 못했어요. 입력 내용은 유지되니 다시 시도해주세요.');
	}
	return settings;
}

/** Load a detached configuration once at request start, consistent throughout the loop. */
export function loadSelectedPromptConfig(): PromptConfig {
	const settings = loadPromptSettings();
	return settings.presets.find((p) => p.id === settings.selectedPresetId)!.config;
}
