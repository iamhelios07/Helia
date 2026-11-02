import type { UpdateGameSettings } from './model.js';

const prefix = 'helia:settings-draft:';

export function loadSettingsDraft(gameId: string): UpdateGameSettings | null {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(prefix + gameId) ?? 'null');
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
		const input = value as Record<string, unknown>;
		if (
			typeof input.title !== 'string' ||
			typeof input.description !== 'string' ||
			typeof input.firstMessage !== 'string' ||
			typeof input.authorNote !== 'string'
		)
			return null;
		return {
			title: input.title,
			description: input.description,
			firstMessage: input.firstMessage,
			authorNote: input.authorNote
		};
	} catch {
		return null;
	}
}

/** Keep pending edits recoverable if the page closes before IndexedDB commits. */
export function storeSettingsDraft(gameId: string, input: UpdateGameSettings): void {
	try {
		localStorage.setItem(prefix + gameId, JSON.stringify(input));
	} catch {
		// IndexedDB autosave still runs when this recovery copy is unavailable.
	}
}

export function clearSettingsDraft(gameId: string, expected: UpdateGameSettings): void {
	try {
		const stored = loadSettingsDraft(gameId);
		if (stored && sameSettings(stored, expected)) localStorage.removeItem(prefix + gameId);
	} catch {
		// A committed save does not depend on removing its recovery copy.
	}
}

export function sameSettings(first: UpdateGameSettings, second: UpdateGameSettings): boolean {
	return (
		first.title === second.title &&
		first.description === second.description &&
		first.firstMessage === second.firstMessage &&
		first.authorNote === second.authorNote
	);
}
