export interface Persona {
	id: string;
	name: string;
	description: string;
}
export interface PersonaSettings {
	version: 1;
	personas: Persona[];
	selectedPersonaId: string | null;
	/** Missing follows the current persona; null explicitly disables it for this session. */
	bindings: Record<string, string | null>;
}

export function emptyPersonaSettings(): PersonaSettings {
	return { version: 1, personas: [], selectedPersonaId: null, bindings: {} };
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('페르소나 설정 형식이 올바르지 않아요.');
	}
	return value as Record<string, unknown>;
}
export function parsePersona(value: unknown): Persona {
	const row = record(value);
	if (typeof row.id !== 'string' || !/^[\w-]{1,80}$/.test(row.id)) {
		throw new Error('페르소나 식별자가 올바르지 않아요.');
	}
	if (
		typeof row.name !== 'string' ||
		!row.name.trim() ||
		row.name.trim().length > 120 ||
		/\p{Cc}/u.test(row.name)
	) {
		throw new Error('페르소나 이름을 1~120자로 입력해주세요.');
	}
	if (typeof row.description !== 'string' || row.description.length > 100000) {
		throw new Error('페르소나 설명은 100,000자까지 입력할 수 있어요.');
	}
	return { id: row.id, name: row.name.trim(), description: row.description };
}
export function personaSessionKey(gameId: string, sessionId: string): string {
	return JSON.stringify([gameId, sessionId]);
}
function parseSessionKey(key: string): string {
	let path: unknown;
	try {
		path = JSON.parse(key);
	} catch {
		throw new Error('페르소나 바인드 형식이 올바르지 않아요.');
	}
	if (
		!Array.isArray(path) ||
		path.length !== 2 ||
		path.some((part: unknown) => typeof part !== 'string' || !part || part.length > 256)
	) {
		throw new Error('페르소나 바인드 형식이 올바르지 않아요.');
	}
	return personaSessionKey(path[0], path[1]);
}
function parseBindings(value: unknown, ids: Set<string>): PersonaSettings['bindings'] {
	const entries = Object.entries(record(value));
	if (entries.length > 10000) {
		throw new Error('페르소나 바인드가 너무 많아요.');
	}
	return Object.fromEntries(
		entries.map(([key, id]) => {
			if (id !== null && (typeof id !== 'string' || !ids.has(id))) {
				throw new Error('페르소나 바인드 형식이 올바르지 않아요.');
			}
			return [parseSessionKey(key), id];
		})
	);
}
export function parsePersonaSettings(value: unknown): PersonaSettings {
	const row = record(value);
	if (row.version !== 1 || !Array.isArray(row.personas) || row.personas.length > 64) {
		throw new Error('페르소나는 최대 64개 저장할 수 있어요.');
	}
	const personas = row.personas.map(parsePersona);
	const ids = new Set(personas.map((persona) => persona.id));
	if (
		ids.size !== personas.length ||
		(row.selectedPersonaId !== null &&
			(typeof row.selectedPersonaId !== 'string' || !ids.has(row.selectedPersonaId)))
	) {
		throw new Error('선택된 페르소나를 확인해주세요.');
	}
	return {
		version: 1,
		personas,
		selectedPersonaId: row.selectedPersonaId as string | null,
		bindings: parseBindings(row.bindings, ids)
	};
}
export function upsertPersona(settings: PersonaSettings, value: Persona): PersonaSettings {
	const persona = parsePersona(value);
	const exists = settings.personas.some((item) => item.id === persona.id);
	return parsePersonaSettings({
		...settings,
		personas: exists
			? settings.personas.map((item) => (item.id === persona.id ? persona : item))
			: [...settings.personas, persona]
	});
}
export function removePersona(settings: PersonaSettings, id: string): PersonaSettings {
	return parsePersonaSettings({
		...settings,
		personas: settings.personas.filter((persona) => persona.id !== id),
		selectedPersonaId: settings.selectedPersonaId === id ? null : settings.selectedPersonaId,
		bindings: Object.fromEntries(
			Object.entries(settings.bindings).map(([key, value]) => [key, value === id ? null : value])
		)
	});
}
export function bindPersona(
	settings: PersonaSettings,
	key: string,
	id: string | null | undefined
): PersonaSettings {
	key = parseSessionKey(key);
	const bindings = { ...settings.bindings };
	if (id === undefined) {
		delete bindings[key];
	} else {
		bindings[key] = id;
	}
	return parsePersonaSettings({ ...settings, bindings });
}
export function resolvePersona(settings: PersonaSettings, key: string): Persona | undefined {
	const id = Object.hasOwn(settings.bindings, key)
		? settings.bindings[key]
		: settings.selectedPersonaId;
	return settings.personas.find((persona) => persona.id === id);
}
