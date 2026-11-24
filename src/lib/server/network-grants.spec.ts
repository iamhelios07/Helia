import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { resolveConsent, type ConsentPrompt } from '#lib/games/network/consent.js';
import { fetchWithPermission } from '#lib/games/network/fetch.js';
import { rememberNetworkGrant } from '#lib/games/network/grants.js';

import { sendNetworkRequest } from './network.js';

beforeEach(() => {
	const stored = new Map<string, string>();
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => stored.get(key) ?? null,
		setItem: (key: string, value: string) => stored.set(key, value)
	});
});
afterEach(() => vi.unstubAllGlobals());

it('still blocks private addresses when the player remembered consent for them', async () => {
	for (const origin of ['http://127.0.0.1', 'http://[::1]', 'http://10.0.0.5']) {
		rememberNetworkGrant('game-1', origin);
		const prompt = vi.fn<ConsentPrompt>();
		await expect(
			fetchWithPermission(
				{ url: `${origin}/`, method: 'GET', headers: [], body: null, redirect: 'follow' },
				new AbortController().signal,
				(target, signal) => resolveConsent(target, signal, 'game-1', prompt),
				(request, signal) => sendNetworkRequest(request, signal).then((sent) => sent.response)
			)
		).rejects.toThrow();
		// The dialog was skipped because of the memory; the host policy rejected the request anyway.
		expect(prompt).not.toHaveBeenCalled();
	}
});
