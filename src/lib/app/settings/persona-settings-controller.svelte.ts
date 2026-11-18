import { loadPersonaSettings, updatePersonaSettings } from './persona-repository.js';
import {
	emptyPersonaSettings,
	removePersona,
	upsertPersona,
	type Persona,
	type PersonaSettings
} from './personas.js';

export class PersonaSettingsController {
	constructor(private requestChange: (action: () => void, dirty?: boolean) => void) {}
	settings = $state.raw<PersonaSettings>(emptyPersonaSettings());
	draft = $state<Persona | null>(null);
	initialDraft = $state('');
	ready = $state(false);
	error = $state('');
	status = $state('');
	dirty = $derived(this.draft !== null && JSON.stringify(this.draft) !== this.initialDraft);
	saved = $derived(this.settings.personas.some((persona) => persona.id === this.draft?.id));
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private cancelSave = () => {
		if (this.saveTimer !== undefined) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}
	};
	setDraft = (persona: Persona | null, fresh = false) => {
		this.cancelSave();
		this.draft = persona ? { ...persona } : null;
		this.initialDraft = fresh ? '' : JSON.stringify(persona);
		this.error = '';
		this.status = '';
	};
	load = () => {
		try {
			this.settings = loadPersonaSettings();
			this.setDraft(
				this.settings.personas.find((persona) => persona.id === this.settings.selectedPersonaId) ??
					this.settings.personas[0] ??
					null
			);
			this.ready = true;
		} catch (cause) {
			this.fail(cause);
		}
	};
	fail = (cause: unknown) => {
		this.error = cause instanceof Error ? cause.message : '페르소나를 저장하지 못했어요.';
	};
	edit = (field: 'name' | 'description', value: string) => {
		if (!this.draft) {
			return;
		}
		this.draft[field] = value;
		this.error = '';
		this.status = '저장 중…';
		this.cancelSave();
		this.saveTimer = setTimeout(this.save, 300);
	};
	discardDraft = () => {
		this.setDraft(
			this.settings.personas.find((persona) => persona.id === this.draft?.id) ??
				this.settings.personas[0] ??
				null
		);
	};
	create = () =>
		this.requestChange(() => {
			this.setDraft(
				{
					id: crypto.randomUUID(),
					name: '새 페르소나',
					description: ''
				},
				true
			);
			this.save();
		});
	select = (persona: Persona) =>
		this.requestChange(() =>
			this.setDraft(this.settings.personas.find((item) => item.id === persona.id) ?? persona)
		);
	duplicate = () =>
		this.requestChange(() => {
			if (this.draft) {
				this.setDraft(
					{
						...this.draft,
						id: crypto.randomUUID(),
						name: `${this.draft.name} 복사본`.slice(0, 120)
					},
					true
				);
				this.save();
			}
		});
	save = (): boolean => {
		this.cancelSave();
		if (!this.draft) {
			return true;
		}
		if (!this.dirty) {
			this.status = '저장됨';
			return true;
		}
		try {
			const draft = $state.snapshot(this.draft);
			this.settings = updatePersonaSettings((settings) => upsertPersona(settings, draft));
			this.initialDraft = JSON.stringify(draft);
			this.error = '';
			this.status = '저장됨';
			return true;
		} catch (cause) {
			this.fail(cause);
			this.status = '저장 실패';
			return false;
		}
	};
	use = (id: string | null) =>
		this.requestChange(() => {
			try {
				this.settings = updatePersonaSettings((settings) => ({
					...settings,
					selectedPersonaId: id
				}));
				this.status = '현재 페르소나를 변경했어요. 다음 AI 요청부터 사용해요.';
			} catch (cause) {
				this.fail(cause);
			}
		});
	rename = (id: string, name: string) => {
		if (!this.save()) {
			throw new Error(this.error);
		}
		this.settings = updatePersonaSettings((settings) => {
			const persona = settings.personas.find((item) => item.id === id);
			if (!persona) {
				throw new Error('페르소나를 다시 불러와주세요.');
			}
			return upsertPersona(settings, { ...persona, name });
		});
		if (this.draft?.id === id) {
			this.draft.name = name.trim();
			const initial = JSON.parse(this.initialDraft) as Persona;
			this.initialDraft = JSON.stringify({ ...initial, name: name.trim() });
		}
	};
	remove = (id: string) => {
		if (this.draft?.id === id) {
			this.cancelSave();
		}
		this.settings = updatePersonaSettings((settings) => removePersona(settings, id));
		if (this.draft?.id === id) {
			this.discardDraft();
		}
	};
	beforeUnload = (event: BeforeUnloadEvent) => {
		if (!this.save()) {
			event.preventDefault();
		}
	};
	dispose = () => {
		this.save();
	};
}
