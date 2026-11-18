import {
	loadPersonaSettings,
	PERSONA_SETTINGS_CHANGED,
	PERSONA_SETTINGS_KEY,
	updatePersonaSettings
} from '#lib/app/settings/persona-repository.js';
import {
	bindPersona,
	emptyPersonaSettings,
	personaSessionKey,
	resolvePersona
} from '#lib/app/settings/personas.js';

export class SessionPersonaController {
	constructor(private context: () => { gameId: string; sessionId: string }) {}
	settings = $state.raw(emptyPersonaSettings());
	ready = $state(false);
	error = $state('');
	get key() {
		const { gameId, sessionId } = this.context();
		return personaSessionKey(gameId, sessionId);
	}
	persona = $derived(resolvePersona(this.settings, this.key));
	selection = $derived(
		Object.hasOwn(this.settings.bindings, this.key)
			? (this.settings.bindings[this.key] ?? ':none')
			: ':current'
	);
	currentName = $derived(
		this.settings.personas.find((persona) => persona.id === this.settings.selectedPersonaId)
			?.name ?? '선택 안 함'
	);
	load = () => {
		try {
			this.settings = loadPersonaSettings();
			this.ready = true;
			this.error = '';
		} catch (cause) {
			this.fail(cause);
			this.ready = false;
		}
	};
	fail = (cause: unknown) => {
		this.error = cause instanceof Error ? cause.message : '페르소나를 불러오지 못했어요.';
	};
	select = (value: string) => {
		try {
			let id: string | null | undefined = value;
			if (value === ':current') {
				id = undefined;
			}
			if (value === ':none') {
				id = null;
			}
			this.settings = updatePersonaSettings((settings) => bindPersona(settings, this.key, id));
			this.error = '';
		} catch (cause) {
			this.fail(cause);
		}
	};
	mount = () => {
		this.load();
		const storage = (event: StorageEvent) => {
			if (event.key === null || event.key === PERSONA_SETTINGS_KEY) {
				this.load();
			}
		};
		window.addEventListener('storage', storage);
		window.addEventListener('focus', this.load);
		window.addEventListener(PERSONA_SETTINGS_CHANGED, this.load);
		return () => {
			window.removeEventListener('storage', storage);
			window.removeEventListener('focus', this.load);
			window.removeEventListener(PERSONA_SETTINGS_CHANGED, this.load);
		};
	};
}
