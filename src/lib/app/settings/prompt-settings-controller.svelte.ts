import { parsePromptConfig, type PromptBlock } from '#lib/games/ai/prompts.js';

import { readPromptPresetFile } from './prompt-import.js';
import { loadPromptSettings, savePromptSettings } from './prompt-repository.js';
import {
	emptyPromptSettings,
	upsertPromptPreset,
	removePromptPreset,
	selectPromptPreset,
	type PromptPreset,
	type PromptSettings
} from './prompts.js';
type RequestChange = (action: () => void, dirty?: boolean) => void;
type RequestConfirmation = (
	heading: string,
	message: string,
	label: string,
	action: () => void
) => void;
export class PromptSettingsController {
	requestChange: RequestChange;
	requestConfirmation: RequestConfirmation;
	constructor(requestChange: RequestChange, requestConfirmation: RequestConfirmation) {
		this.requestChange = requestChange;
		this.requestConfirmation = requestConfirmation;
	}
	settings = $state.raw<PromptSettings>(emptyPromptSettings());
	draft = $state<PromptPreset | null>(null);
	blocks = $state<
		{
			id: string;
			value: PromptBlock;
		}[]
	>([]);
	initialDraft = $state('');
	ready = $state(false);
	error = $state('');
	status = $state('');
	importError = $state('');
	readingFile = $state(false);
	importFileInput: HTMLInputElement | undefined;
	exportText = $state('');
	openBlockIds = $state<string[]>([]);
	disposed = false;
	fileRequest = 0;
	draftDirty = $derived.by(
		() => this.draft !== null && JSON.stringify(this.currentDraft()) !== this.initialDraft
	);
	savedDraft = $derived(this.settings.presets.some((preset) => preset.id === this.draft?.id));
	activeDraft = $derived(this.savedDraft && this.draft?.id === this.settings.selectedPresetId);
	hasUnsavedChanges = () => {
		return this.draftDirty;
	};
	isBusy = () => {
		return this.readingFile;
	};
	discardDraft = () => {
		const saved =
			this.settings.presets.find((preset) => preset.id === this.draft?.id) ??
			this.settings.presets.find((preset) => preset.id === this.settings.selectedPresetId)!;
		this.setDraft(saved);
	};
	currentDraft = (): PromptPreset | null => {
		if (!this.draft) {
			return null;
		}
		return {
			...this.draft,
			config: { ...this.draft.config, promptTemplate: this.blocks.map((entry) => entry.value) }
		};
	};
	readableError = (cause: unknown, fallback: string) => {
		return cause instanceof Error &&
			!(cause instanceof SyntaxError) &&
			!cause.message.startsWith('AI 응답')
			? cause.message
			: fallback;
	};
	setDraft = (preset: PromptPreset, fresh = false) => {
		this.draft = structuredClone($state.snapshot(preset));
		this.blocks = preset.config.promptTemplate.map((block) => ({
			id: crypto.randomUUID(),
			value: structuredClone($state.snapshot(block))
		}));
		this.openBlockIds = this.blocks[0] ? [this.blocks[0].id] : [];
		this.initialDraft = fresh ? '' : JSON.stringify(preset);
		this.error = '';
		this.status = '';
		this.exportText = '';
		this.importError = '';
	};
	load = () => {
		try {
			this.settings = loadPromptSettings();
			this.setDraft(
				this.settings.presets.find((preset) => preset.id === this.settings.selectedPresetId)!
			);
			this.ready = true;
		} catch (cause) {
			this.ready = false;
			this.error = this.readableError(cause, '프롬프트 설정을 불러오지 못했어요.');
		}
	};
	newPreset = () => {
		this.requestChange(() =>
			this.setDraft(
				{ id: crypto.randomUUID(), name: '새 프롬프트', config: parsePromptConfig(undefined) },
				true
			)
		);
	};
	duplicatePreset = () => {
		this.requestChange(() => {
			const source = this.currentDraft();
			if (source) {
				this.setDraft(
					{ ...source, id: crypto.randomUUID(), name: `${source.name} 복사본`.slice(0, 120) },
					true
				);
			}
		});
	};
	savePreset = (event: SubmitEvent) => {
		event.preventDefault();
		const candidate = this.currentDraft();
		if (!candidate) {
			return;
		}
		try {
			this.settings = savePromptSettings(upsertPromptPreset(this.settings, candidate));
			this.setDraft(this.settings.presets.find((preset) => preset.id === candidate.id)!);
			this.status = '프롬프트 프리셋을 저장했어요.';
		} catch (cause) {
			this.error = this.readableError(cause, '프롬프트 입력값을 확인해주세요.');
		}
	};
	usePreset = () => {
		const id = this.draft?.id;
		if (!id || !this.savedDraft) {
			return;
		}
		this.requestChange(() => {
			try {
				this.settings = savePromptSettings(selectPromptPreset(this.settings, id));
				this.status = '기본 프롬프트를 변경했어요. 다음 AI 요청부터 사용해요.';
			} catch (cause) {
				this.error = this.readableError(cause, '기본 프롬프트를 변경하지 못했어요.');
			}
		});
	};
	deletePreset = () => {
		const id = this.draft?.id;
		if (!id || !this.savedDraft || this.settings.presets.length < 2) {
			return;
		}
		this.requestChange(() =>
			this.requestConfirmation(
				'프롬프트 프리셋 삭제',
				'이 프리셋을 삭제할까요? 사용 중인 프리셋이면 다른 프리셋으로 전환해요.',
				'프리셋 삭제',
				() => {
					try {
						this.settings = savePromptSettings(removePromptPreset(this.settings, id));
						this.setDraft(
							this.settings.presets.find((preset) => preset.id === this.settings.selectedPresetId)!
						);
						this.status = '프롬프트 프리셋을 삭제했어요.';
					} catch (cause) {
						this.error = this.readableError(cause, '프리셋을 삭제하지 못했어요.');
					}
				}
			)
		);
	};
	moveBlock = (index: number, offset: number) => {
		const next = index + offset;
		if (next < 0 || next >= this.blocks.length) {
			return;
		}
		const reordered = [...this.blocks];
		[reordered[index], reordered[next]] = [reordered[next], reordered[index]];
		this.blocks = reordered;
	};
	addBlock = () => {
		if (this.blocks.length >= 128) {
			return;
		}
		const id = crypto.randomUUID();
		this.blocks.push({ id, value: { type: 'plain', role: 'system', enabled: true, text: '' } });
		this.openBlockIds.push(id);
	};
	readImportFile = async (event: Event) => {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) {
			return;
		}
		const request = ++this.fileRequest;
		this.importError = '';
		this.readingFile = true;
		let candidate: PromptPreset | undefined;
		try {
			candidate = { id: crypto.randomUUID(), ...(await readPromptPresetFile(file)) };
		} catch (cause) {
			if (!this.disposed && request === this.fileRequest) {
				this.importError = this.readableError(
					cause,
					'프롬프트 파일을 가져오지 못했어요. 파일을 확인해주세요.'
				);
			}
		} finally {
			if (!this.disposed && request === this.fileRequest) {
				this.readingFile = false;
			}
		}
		if (candidate && !this.disposed && request === this.fileRequest) {
			const preset = candidate;
			this.requestChange(() => this.setDraft(preset, true), this.draftDirty);
		}
	};
	attachImportFile = (input: HTMLInputElement) => {
		this.importFileInput = input;
		return () => {
			if (this.importFileInput === input) {
				this.importFileInput = undefined;
			}
		};
	};
	exportPreset = () => {
		const candidate = this.currentDraft();
		if (!candidate) {
			return;
		}
		try {
			this.exportText = JSON.stringify(
				{ version: 1, name: candidate.name, config: parsePromptConfig(candidate.config) },
				null,
				2
			);
			this.error = '';
		} catch (cause) {
			this.error = this.readableError(cause, '내보낼 프롬프트 입력값을 확인해주세요.');
		}
	};
	downloadPreset = () => {
		if (!this.exportText) {
			return;
		}
		const url = URL.createObjectURL(new Blob([this.exportText], { type: 'application/json' }));
		const link = document.createElement('a');
		link.href = url;
		link.download = 'helia-prompt.json';
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 0);
	};
	dispose = () => {
		this.disposed = true;
		this.fileRequest++;
	};
}
