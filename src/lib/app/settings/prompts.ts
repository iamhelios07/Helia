import { parsePromptConfig, type PromptConfig } from '#lib/games/ai/prompts.js';

export interface PromptPreset {
	id: string;
	name: string;
	config: PromptConfig;
}
export interface PromptSettings {
	version: 1;
	presets: PromptPreset[];
	selectedPresetId: string;
}

export function emptyPromptSettings(): PromptSettings {
	return {
		version: 1,
		presets: [{ id: 'default', name: '기본 프롬프트', config: parsePromptConfig(undefined) }],
		selectedPresetId: 'default'
	};
}

export function parsePromptSettings(value: unknown): PromptSettings {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('프롬프트 설정 형식이 올바르지 않아요.');
	}
	const input = value as Record<string, unknown>;
	if (
		input.version !== 1 ||
		!Array.isArray(input.presets) ||
		input.presets.length < 1 ||
		input.presets.length > 64
	) {
		throw new Error('프롬프트 프리셋은 1~64개 저장할 수 있어요.');
	}
	const presets = input.presets.map((value): PromptPreset => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error('프롬프트 프리셋 형식이 올바르지 않아요.');
		}
		const row = value as Record<string, unknown>;
		if (typeof row.id !== 'string' || !/^[\w-]{1,80}$/.test(row.id)) {
			throw new Error('프롬프트 프리셋 식별자가 올바르지 않아요.');
		}
		if (
			typeof row.name !== 'string' ||
			!row.name.trim() ||
			row.name.trim().length > 120 ||
			/\p{Cc}/u.test(row.name)
		) {
			throw new Error('프리셋 이름을 1~120자로 입력해주세요.');
		}
		return { id: row.id, name: row.name.trim(), config: parsePromptConfig(row.config) };
	});
	const ids = new Set(presets.map((p) => p.id));
	if (ids.size !== presets.length) {
		throw new Error('중복된 프롬프트 프리셋 식별자가 있어요.');
	}
	if (typeof input.selectedPresetId !== 'string' || !ids.has(input.selectedPresetId)) {
		throw new Error('사용할 프롬프트 프리셋을 선택해주세요.');
	}
	return { version: 1, presets, selectedPresetId: input.selectedPresetId };
}

export function upsertPromptPreset(settings: PromptSettings, preset: PromptPreset): PromptSettings {
	const exists = settings.presets.some((p) => p.id === preset.id);
	return parsePromptSettings({
		...settings,
		presets: exists
			? settings.presets.map((p) => (p.id === preset.id ? preset : p))
			: [...settings.presets, preset]
	});
}
export function removePromptPreset(settings: PromptSettings, id: string): PromptSettings {
	const presets = settings.presets.filter((p) => p.id !== id);
	return parsePromptSettings({
		...settings,
		presets,
		selectedPresetId: settings.selectedPresetId === id ? presets[0]?.id : settings.selectedPresetId
	});
}
export function selectPromptPreset(settings: PromptSettings, id: string): PromptSettings {
	return parsePromptSettings({ ...settings, selectedPresetId: id });
}
