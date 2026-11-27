import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { encodeGamePackage } from '../package/codec.js';
import minimal from '../package/fixtures/minimal-release.json';
import { decodeZip } from '../package/zip.js';
import { resolveConsent, type ConsentPrompt } from './consent.js';
import {
	forgetNetworkGrants,
	isNetworkGrantRemembered,
	listNetworkGrants,
	NETWORK_GRANTS_KEY,
	rememberNetworkGrant,
	revokeNetworkGrant
} from './grants.js';

const origin = 'https://api.example';
let stored: Map<string, string>;
beforeEach(() => {
	stored = new Map();
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => stored.get(key) ?? null,
		setItem: (key: string, value: string) => stored.set(key, value)
	});
});
afterEach(() => vi.unstubAllGlobals());
const signal = () => new AbortController().signal;
const answer = (allowed: boolean, remember: boolean) =>
	vi.fn<ConsentPrompt>().mockResolvedValue({ allowed, remember });

it('does not ask again for the same game and origin once the player chose to remember', async () => {
	const prompt = answer(true, true);
	await expect(resolveConsent(origin, signal(), 'game-1', prompt)).resolves.toBe(true);
	expect(prompt).toHaveBeenCalledWith(origin, expect.any(AbortSignal), true);
	await expect(resolveConsent(origin, signal(), 'game-1', prompt)).resolves.toBe(true);
	expect(prompt).toHaveBeenCalledOnce();
	expect(listNetworkGrants()).toEqual([{ gameId: 'game-1', origin }]);
});
it('keeps remembering across app restarts because the grant is persisted, not held in memory', async () => {
	await resolveConsent(origin, signal(), 'game-1', answer(true, true));
	const saved = [...stored];
	stored = new Map(saved);
	expect(isNetworkGrantRemembered('game-1', origin)).toBe(true);
});
it('asks for another game or another origin', async () => {
	rememberNetworkGrant('game-1', origin);
	const prompt = answer(true, false);
	await resolveConsent(origin, signal(), 'game-2', prompt);
	await resolveConsent('https://api.example:8443', signal(), 'game-1', prompt);
	await resolveConsent('http://api.example', signal(), 'game-1', prompt);
	expect(prompt).toHaveBeenCalledTimes(3);
});
it('asks again after the player cancels a remembered grant, and only that grant', async () => {
	rememberNetworkGrant('game-1', origin);
	rememberNetworkGrant('game-1', 'https://other.example');
	rememberNetworkGrant('game-2', origin);
	expect(revokeNetworkGrant('game-1', origin)).toBe(true);
	const prompt = answer(true, false);
	await resolveConsent(origin, signal(), 'game-1', prompt);
	expect(prompt).toHaveBeenCalledOnce();
	expect(isNetworkGrantRemembered('game-1', 'https://other.example')).toBe(true);
	expect(isNetworkGrantRemembered('game-2', origin)).toBe(true);
});
it('does not remember an allow answer that left the checkbox unchecked', async () => {
	const prompt = answer(true, false);
	await resolveConsent(origin, signal(), 'game-1', prompt);
	await resolveConsent(origin, signal(), 'game-1', prompt);
	expect(prompt).toHaveBeenCalledTimes(2);
	expect(stored.has(NETWORK_GRANTS_KEY)).toBe(false);
});
it('never remembers a denial, even with the checkbox checked', async () => {
	const prompt = answer(false, true);
	await expect(resolveConsent(origin, signal(), 'game-1', prompt)).resolves.toBe(false);
	await expect(resolveConsent(origin, signal(), 'game-1', prompt)).resolves.toBe(false);
	expect(prompt).toHaveBeenCalledTimes(2);
	expect(stored.has(NETWORK_GRANTS_KEY)).toBe(false);
});
it('does not remember when the request was cancelled while the dialog was open', async () => {
	const abort = new AbortController();
	const prompt = vi.fn<ConsentPrompt>().mockImplementation(async () => {
		abort.abort();
		return { allowed: true, remember: true };
	});
	await resolveConsent(origin, abort.signal, 'game-1', prompt);
	expect(stored.has(NETWORK_GRANTS_KEY)).toBe(false);
});
it('offers no remember choice and stores nothing when the game is unknown', async () => {
	const prompt = answer(true, true);
	await resolveConsent(origin, signal(), undefined, prompt);
	expect(prompt).toHaveBeenCalledWith(origin, expect.any(AbortSignal), false);
	expect(stored.has(NETWORK_GRANTS_KEY)).toBe(false);
});
it.each([
	['invalid JSON', '{'],
	['not an object', '[]'],
	['wrong version', JSON.stringify({ version: 2, grants: { 'game-1': [origin] } })],
	['grants is an array', JSON.stringify({ version: 1, grants: [origin] })],
	['origins is not an array', JSON.stringify({ version: 1, grants: { 'game-1': origin } })],
	['origin is not a string', JSON.stringify({ version: 1, grants: { 'game-1': [42, null] } })],
	[
		'origin is not normalized',
		JSON.stringify({
			version: 1,
			grants: { 'game-1': ['https://api.example/', 'https://API.example', 'https://u@api.example'] }
		})
	],
	['origin is not HTTP', JSON.stringify({ version: 1, grants: { 'game-1': ['file:///etc'] } })],
	['oversized document', 'x'.repeat(2 * 1024 * 1024)]
])('ignores a damaged stored value and asks again: %s', async (_name, raw) => {
	stored.set(NETWORK_GRANTS_KEY, raw);
	expect(isNetworkGrantRemembered('game-1', origin)).toBe(false);
	expect(listNetworkGrants()).toEqual([]);
	const prompt = answer(true, false);
	await resolveConsent(origin, signal(), 'game-1', prompt);
	expect(prompt).toHaveBeenCalledOnce();
});
it('keeps valid entries when only some stored entries are damaged', () => {
	stored.set(
		NETWORK_GRANTS_KEY,
		JSON.stringify({
			version: 1,
			grants: { 'game-1': [origin, 'nonsense', 7], 'game-2': 'bad', '': [origin] }
		})
	);
	expect(listNetworkGrants()).toEqual([{ gameId: 'game-1', origin }]);
});
it('treats unreadable or unwritable storage as no memory instead of failing the request', async () => {
	vi.stubGlobal('localStorage', {
		getItem: () => {
			throw new Error('blocked');
		},
		setItem: () => {
			throw new Error('full');
		}
	});
	expect(isNetworkGrantRemembered('game-1', origin)).toBe(false);
	expect(rememberNetworkGrant('game-1', origin)).toBe(false);
	expect(revokeNetworkGrant('game-1', origin)).toBe(true);
	const prompt = answer(true, true);
	await expect(resolveConsent(origin, signal(), 'game-1', prompt)).resolves.toBe(true);
	await resolveConsent(origin, signal(), 'game-1', prompt);
	expect(prompt).toHaveBeenCalledTimes(2);
});
const reportRecorder = () => {
	const reported: unknown[] = [];
	vi.stubGlobal('window', {
		dispatchEvent: (event: Event) => {
			reported.push((event as CustomEvent).detail);
			return true;
		}
	});
	return reported;
};
it('tells the player when a remembered consent cannot be saved, without denying the request', async () => {
	const reported = reportRecorder();
	vi.stubGlobal('localStorage', {
		getItem: () => null,
		setItem: () => {
			throw new Error('full');
		}
	});
	await expect(resolveConsent(origin, signal(), 'game-1', answer(true, true))).resolves.toBe(true);
	expect(reported).toEqual([origin]);
	expect(isNetworkGrantRemembered('game-1', origin)).toBe(false);
});
it('does not report a failed write when the request was allowed without remembering', async () => {
	const reported = reportRecorder();
	vi.stubGlobal('localStorage', {
		getItem: () => null,
		setItem: () => {
			throw new Error('full');
		}
	});
	await resolveConsent(origin, signal(), 'game-1', answer(true, false));
	const abort = new AbortController();
	const prompt = vi.fn<ConsentPrompt>().mockImplementation(async () => {
		abort.abort();
		return { allowed: true, remember: true };
	});
	await resolveConsent(origin, abort.signal, 'game-1', prompt);
	expect(reported).toEqual([]);
});
it('reports a failed revoke so the grant is not shown as cancelled', () => {
	rememberNetworkGrant('game-1', origin);
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => stored.get(key) ?? null,
		setItem: () => {
			throw new Error('full');
		}
	});
	expect(revokeNetworkGrant('game-1', origin)).toBe(false);
	expect(isNetworkGrantRemembered('game-1', origin)).toBe(true);
});
it('fails quietly when a deleted game cannot forget its grants, without throwing', () => {
	rememberNetworkGrant('game-1', origin);
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => stored.get(key) ?? null,
		setItem: () => {
			throw new Error('full');
		}
	});
	expect(() => forgetNetworkGrants('game-1')).not.toThrow();
	expect(forgetNetworkGrants('game-1')).toBe(false);
	expect(forgetNetworkGrants('never-stored')).toBe(true);
});
it('refuses to remember anything that is not a normalized origin', () => {
	for (const value of ['https://api.example/path', 'ftp://api.example', 'api.example', '']) {
		expect(rememberNetworkGrant('game-1', value)).toBe(false);
	}
	expect(rememberNetworkGrant('', origin)).toBe(false);
	expect(stored.has(NETWORK_GRANTS_KEY)).toBe(false);
});
it('forgets every grant of a permanently deleted game only', () => {
	rememberNetworkGrant('game-1', origin);
	rememberNetworkGrant('game-1', 'https://other.example');
	rememberNetworkGrant('game-2', origin);
	expect(forgetNetworkGrants('game-1')).toBe(true);
	expect(listNetworkGrants()).toEqual([{ gameId: 'game-2', origin }]);
});
it('treats a duplicated game under a new ID as a different game', () => {
	rememberNetworkGrant('game-1', origin);
	expect(isNetworkGrantRemembered('game-1-copy', origin)).toBe(false);
});
it('stays out of exported game packages and uses only its own storage key', async () => {
	rememberNetworkGrant(minimal.originalGameId, 'https://secret-origin.example');
	expect([...stored.keys()]).toEqual([NETWORK_GRANTS_KEY]);
	const bytes = await encodeGamePackage(
		structuredClone(minimal) as Parameters<typeof encodeGamePackage>[0]
	);
	const text = decodeZip(bytes)
		.map((entry) => new TextDecoder().decode(entry.data))
		.join('\n');
	expect(text).not.toContain('secret-origin.example');
	expect(text).not.toContain(NETWORK_GRANTS_KEY);
	expect(new TextDecoder('latin1').decode(bytes)).not.toContain('secret-origin.example');
});
