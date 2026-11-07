/** Recovery for the public library metadata; never share the legacy AI settings draft key. */
export interface MetadataDraft {
	title: string;
	description: string;
}
const prefix = 'helia:metadata-draft:';

export function loadMetadataDraft(gameId: string): MetadataDraft | null {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(prefix + gameId) ?? 'null');
		if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
		const input = value as Record<string, unknown>;
		return typeof input.title === 'string' && typeof input.description === 'string'
			? { title: input.title, description: input.description }
			: null;
	} catch {
		return null;
	}
}

export function storeMetadataDraft(gameId: string, input: MetadataDraft): void {
	try {
		localStorage.setItem(prefix + gameId, JSON.stringify(input));
	} catch {
		/* The primary repository write still runs if the recovery copy is unavailable. */
	}
}

export function clearMetadataDraft(gameId: string, expected: MetadataDraft): void {
	try {
		const stored = loadMetadataDraft(gameId);
		if (stored && sameMetadata(stored, expected)) localStorage.removeItem(prefix + gameId);
	} catch {
		/* Committed metadata does not depend on cleanup of a recovery copy. */
	}
}

export function sameMetadata(first: MetadataDraft, second: MetadataDraft): boolean {
	return first.title === second.title && first.description === second.description;
}
