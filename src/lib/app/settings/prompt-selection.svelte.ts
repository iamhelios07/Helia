import type { PromptConfig } from '#lib/games/ai/prompts.js';

import {
	parsePromptToggles,
	toggleControls,
	validateToggleValue
} from '#lib/games/ai/prompt-toggles.js';

import {
	loadPromptSettings,
	savePromptSettings,
	PROMPT_SETTINGS_KEY,
	PROMPT_SETTINGS_CHANGED
} from './prompt-repository.js';

/** The active device preset, shared by sidebar controls and rendered chat. */
export class PromptSelection {
	config = $state.raw<PromptConfig | undefined>();
	id = $state('');
	name = $state('');
	error = $state('');
	items = $derived(parsePromptToggles(this.config?.toggles ?? ''));
	load = () => {
		try {
			const settings = loadPromptSettings();
			const preset = settings.presets.find((item) => item.id === settings.selectedPresetId)!;
			this.config = preset.config;
			this.id = preset.id;
			this.name = preset.name;
			this.error = '';
		} catch (cause) {
			this.config = undefined;
			this.error = cause instanceof Error ? cause.message : '프리셋을 불러오지 못했어요.';
		}
	};
	setValue = (key: string, value: string) => {
		try {
			const settings = loadPromptSettings();
			const preset = settings.presets.find((item) => item.id === this.id);
			if (!preset || settings.selectedPresetId !== this.id) {
				throw new Error('프리셋이 변경됐어요. 다시 불러와주세요.');
			}
			const control = toggleControls(parsePromptToggles(preset.config.toggles)).find(
				(item) => item.key === key
			);
			if (!control) {
				throw new Error('토글을 찾을 수 없어요. 다시 불러와주세요.');
			}
			preset.config.toggleValues[key] = validateToggleValue(control, value);
			savePromptSettings(settings);
			this.load();
		} catch (cause) {
			this.error = cause instanceof Error ? cause.message : '토글을 저장하지 못했어요.';
		}
	};
	mount = () => {
		this.load();
		const storage = (event: StorageEvent) => {
			if (event.key === null || event.key === PROMPT_SETTINGS_KEY) {
				this.load();
			}
		};
		window.addEventListener('storage', storage);
		window.addEventListener('focus', this.load);
		window.addEventListener(PROMPT_SETTINGS_CHANGED, this.load);
		return () => {
			window.removeEventListener('storage', storage);
			window.removeEventListener('focus', this.load);
			window.removeEventListener(PROMPT_SETTINGS_CHANGED, this.load);
		};
	};
}
