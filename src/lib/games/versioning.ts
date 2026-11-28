import type { Game } from './model.js';

export { compareSemVer, parseSemVer } from './semver.js';

export type GameReleaseSummary = {
	id: string;
	originalGameId: string;
	contentVersion: string;
	contentHash: string;
	createdAt: string;
};
export type GameVersioning = {
	originalGameId: string;
	contentHash: string;
	currentRelease: GameReleaseSummary | null;
	releases: GameReleaseSummary[];
	modified: boolean;
};
export type CreateGameReleaseResult =
	| { kind: 'released'; state: GameVersioning }
	| { kind: 'conflict'; contentVersion: string; existingHashes: string[]; incomingHash: string };

/** Portable authored content. Runtime builds and installation/player identity are absent. */
export type GameReleaseContent = Pick<
	Game,
	'title' | 'genre' | 'description' | 'settings' | 'schema' | 'initialState'
> &
	Partial<Pick<Game, 'code' | 'scripts' | 'ui' | 'ai' | 'regex' | 'resources'>>;
/** Host-confirmed metadata for each `helia-asset:<blobId>` reference in a stored release. */
export interface GameReleaseAsset {
	mime: string;
	size: number;
	sha256: string;
}
export type GameRelease = GameReleaseSummary & {
	content: GameReleaseContent;
	assets?: Record<string, GameReleaseAsset>;
};
/** Result of recomputing a stored release digest on the host (`verifyRelease`). */
export interface ReleaseVerification {
	contentHash: string;
	valid: boolean;
}
export interface GameReleaseOptions {
	ignoreConflict?: boolean;
	expectedContentHash?: string;
}

export function originalGameId(value: unknown): string {
	if (
		typeof value !== 'string' ||
		value.length !== 36 ||
		!/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(value)
	) {
		throw Error('Invalid original game UUID');
	}
	return value;
}
