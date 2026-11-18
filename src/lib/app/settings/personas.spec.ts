import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
	loadPersonaSettings,
	loadSessionPersona,
	PERSONA_SETTINGS_KEY,
	savePersonaSettings,
	updatePersonaSettings
} from './persona-repository.js';
import {
	bindPersona,
	emptyPersonaSettings,
	parsePersonaSettings,
	personaSessionKey,
	removePersona,
	resolvePersona,
	upsertPersona
} from './personas.js';

const first = { id: 'first', name: '여행자', description: '길을 찾는 여행자' };
const second = { id: 'second', name: '기사', description: '서약을 지키는 기사' };
const session = personaSessionKey('game', 'one');
function settings() {
	return {
		...upsertPersona(upsertPersona(emptyPersonaSettings(), first), second),
		selectedPersonaId: first.id
	};
}
beforeEach(() => {
	const stored = new Map<string, string>();
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => stored.get(key) ?? null,
		setItem: (key: string, value: string) => stored.set(key, value)
	});
});
afterEach(() => vi.unstubAllGlobals());

it('keeps default followers, fixed sessions and disabled sessions independent', () => {
	const fixed = personaSessionKey('game', 'two');
	const disabled = personaSessionKey('game', 'three');
	const bound = bindPersona(bindPersona(settings(), fixed, first.id), disabled, null);
	const changed = parsePersonaSettings({ ...bound, selectedPersonaId: second.id });
	expect(resolvePersona(changed, session)).toEqual(second);
	expect(resolvePersona(changed, fixed)).toEqual(first);
	expect(resolvePersona(changed, disabled)).toBeUndefined();
	expect(resolvePersona(bindPersona(changed, fixed, undefined), fixed)).toEqual(second);
	expect(resolvePersona(changed, personaSessionKey('other-game', 'two'))).toEqual(second);
});
it('removes a deleted persona without silently binding affected sessions to another identity', () => {
	const bound = bindPersona({ ...settings(), selectedPersonaId: second.id }, session, first.id);
	const removed = removePersona(bound, first.id);
	expect(removed.selectedPersonaId).toBe(second.id);
	expect(removed.bindings[session]).toBeNull();
	expect(resolvePersona(removed, session)).toBeUndefined();
	expect(removePersona(removed, second.id).selectedPersonaId).toBeNull();
});
it('validates external persona data, references and binding paths', () => {
	expect(
		upsertPersona(emptyPersonaSettings(), { ...first, name: '  여행자  ' }).personas[0].name
	).toBe('여행자');
	expect(() => upsertPersona(settings(), { ...first, name: ' ' })).toThrow('이름');
	expect(() => upsertPersona(settings(), { ...first, description: 'x'.repeat(100001) })).toThrow(
		'설명'
	);
	expect(() => parsePersonaSettings({ ...settings(), personas: [first, first] })).toThrow();
	expect(() => bindPersona(settings(), session, 'missing')).toThrow('바인드');
	expect(() => bindPersona(settings(), '__proto__', first.id)).toThrow('바인드');
	expect(() => parsePersonaSettings({ ...settings(), selectedPersonaId: 'missing' })).toThrow();
});
it('persists bindings, re-reads before editing and returns detached invocation data', () => {
	expect(loadPersonaSettings()).toEqual(emptyPersonaSettings());
	savePersonaSettings(bindPersona(settings(), session, second.id));
	const captured = loadSessionPersona('game', 'one');
	updatePersonaSettings((value) => upsertPersona(value, { ...second, description: '새 설명' }));
	expect(loadPersonaSettings().bindings[session]).toBe(second.id);
	expect(loadSessionPersona('game', 'one')?.description).toBe('새 설명');
	expect(captured?.description).toBe(second.description);
});
it('reports corrupt or unwritable storage without replacing saved data', () => {
	localStorage.setItem(PERSONA_SETTINGS_KEY, '{broken');
	expect(() => loadPersonaSettings()).toThrow('불러오지');
	expect(() => updatePersonaSettings(() => settings())).toThrow('불러오지');
	expect(localStorage.getItem(PERSONA_SETTINGS_KEY)).toBe('{broken');
	vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
		throw Error('Quota');
	});
	expect(() => savePersonaSettings(settings())).toThrow('저장하지');
});
