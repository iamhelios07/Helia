import { networkURL } from './protocol.js';

/**
 * Player-owned memory of "do not ask again" network consents, keyed by game ID and origin.
 * It lives in the device/browser profile next to the other player settings. It is never part of
 * game data, history, sessions, exported packages or the credential store, and nothing in the
 * game sandbox can reach it: only trusted UI code and the host-side permission gate import it.
 */
export const NETWORK_GRANTS_KEY = 'helia:network-grants';
export const NETWORK_GRANTS_CHANGED = 'helia:network-grants-changed';
const MAX_DOCUMENT_CHARS = 1024 * 1024;
const MAX_ID_CHARS = 256;
const MAX_ORIGIN_CHARS = 2048;

export interface NetworkGrant {
	gameId: string;
	origin: string;
}
type Grants = Map<string, string[]>;

/** Uses the same URL normalization as the fetch gate; anything else is not an origin. */
export function normalizeGrantOrigin(value: unknown): string | null {
	if (typeof value !== 'string' || value.length > MAX_ORIGIN_CHARS) {
		return null;
	}
	try {
		const { origin } = networkURL(value);
		return origin === value ? origin : null;
	} catch {
		return null;
	}
}
function validGameId(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS;
}
/** Corrupt documents or entries are ignored, which means the player is asked again. */
function parseGrants(raw: string | null): Grants {
	const grants: Grants = new Map();
	if (raw === null || raw.length > MAX_DOCUMENT_CHARS) {
		return grants;
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return grants;
	}
	if (!value || typeof value !== 'object' || Reflect.get(value, 'version') !== 1) {
		return grants;
	}
	const stored: unknown = Reflect.get(value, 'grants');
	if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
		return grants;
	}
	for (const [gameId, origins] of Object.entries(stored)) {
		const valid = validGameId(gameId) ? validOrigins(origins) : [];
		if (valid.length) {
			grants.set(gameId, valid);
		}
	}
	return grants;
}
function validOrigins(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const valid = new Set<string>();
	for (const item of value) {
		const origin = normalizeGrantOrigin(item);
		if (origin) {
			valid.add(origin);
		}
	}
	return [...valid];
}
function readGrants(): Grants {
	try {
		return parseGrants(localStorage.getItem(NETWORK_GRANTS_KEY));
	} catch {
		return new Map();
	}
}
function writeGrants(grants: Grants): boolean {
	const document = JSON.stringify({
		version: 1,
		grants: Object.fromEntries(grants)
	});
	if (document.length > MAX_DOCUMENT_CHARS) {
		return false;
	}
	try {
		localStorage.setItem(NETWORK_GRANTS_KEY, document);
	} catch {
		return false;
	}
	if (typeof window !== 'undefined') {
		window.dispatchEvent(new Event(NETWORK_GRANTS_CHANGED));
	}
	return true;
}
export function isNetworkGrantRemembered(gameId: string, origin: string): boolean {
	return readGrants().get(gameId)?.includes(origin) ?? false;
}
export function listNetworkGrants(): NetworkGrant[] {
	return [...readGrants()].flatMap(([gameId, origins]) =>
		origins.map((origin) => ({ gameId, origin }))
	);
}
/** Returns false when the origin is invalid or storage rejects the write; the request still proceeds. */
export function rememberNetworkGrant(gameId: string, origin: string): boolean {
	const normalized = normalizeGrantOrigin(origin);
	if (!validGameId(gameId) || !normalized) {
		return false;
	}
	const grants = readGrants();
	const origins = grants.get(gameId) ?? [];
	if (origins.includes(normalized)) {
		return true;
	}
	grants.set(gameId, [...origins, normalized]);
	return writeGrants(grants);
}
/** Returns false when storage rejects the write so callers can report that the grant remains. */
export function revokeNetworkGrant(gameId: string, origin: string): boolean {
	const grants = readGrants();
	const origins = grants.get(gameId);
	if (!origins?.includes(origin)) {
		return true;
	}
	const rest = origins.filter((item) => item !== origin);
	if (rest.length) {
		grants.set(gameId, rest);
	} else {
		grants.delete(gameId);
	}
	return writeGrants(grants);
}
/** Called when a game is permanently deleted. Trash keeps grants so a restored game behaves as before. */
export function forgetNetworkGrants(gameId: string): boolean {
	const grants = readGrants();
	return grants.delete(gameId) ? writeGrants(grants) : true;
}
