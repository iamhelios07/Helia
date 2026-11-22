import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

import fixture from '#lib/testing/fixtures/service-account.json';

import { POST } from '../../routes/api/games/[id]/secrets/+server.js';
import { POST as networkPOST } from '../../routes/api/network/+server.js';
import { openCredentialStore } from './credentials.js';
import { GameSecretStore } from './game-secrets.js';
import { SecretResponseGuard } from './secret-response.js';
vi.mock('./game-secrets.js', async (original) => ({
	...(await original<typeof import('./game-secrets.js')>()),
	serverGameSecrets: () => store
}));
vi.mock('./network-policy.js', () => ({
	networkAddresses: async () => [{ address: '8.8.8.8', family: 4 }]
}));
let directory: string, store: GameSecretStore;
const url = 'https://api.example/image',
	value = 'test-game-secret-not-real';
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'helia-game-secrets-'));
	store = new GameSecretStore(
		join(directory, 'game-secrets.sqlite'),
		join(directory, 'secrets', 'game.key')
	);
});
afterEach(() => {
	store.close();
	vi.unstubAllGlobals();
	if (
		!resolve(directory).startsWith(resolve(tmpdir()) + '\\helia-game-secrets-') &&
		!resolve(directory).startsWith(resolve(tmpdir()) + '/helia-game-secrets-')
	) {
		throw Error('Unexpected cleanup');
	}
	rmSync(directory, { recursive: true, force: true });
});
it('encrypts persistent game-wide values and binds references to their game and exact HTTPS destination', () => {
	store.request('game-a', { kind: 'set', name: 'novelai', value, url });
	expect(store.request('game-a', { kind: 'has', name: 'novelai' })).toBe(true);
	expect(store.request('game-b', { kind: 'has', name: 'novelai' })).toBe(false);
	const ref = store.request('game-a', { kind: 'ref', name: 'novelai' }) as string;
	expect(ref).not.toContain(value);
	expect(store.authorize('game-a', url, [['authorization', 'Bearer ' + ref]]).headers).toEqual([
		['authorization', 'Bearer ' + value]
	]);
	store.request('game-b', { kind: 'set', name: 'novelai', value, url });
	expect(() => store.authorize('game-b', url, [['authorization', ref]])).toThrow();
	expect(() => store.authorize(undefined, url, [['authorization', ref]])).toThrow();
	expect(() => store.authorize('game-a', url + '/other', [['authorization', ref]])).toThrow();
	expect(() =>
		store.authorize('game-a', 'https://another.example/image', [['x-key', ref]])
	).toThrow();
	store.close();
	store = new GameSecretStore(
		join(directory, 'game-secrets.sqlite'),
		join(directory, 'secrets', 'game.key')
	);
	expect(store.request('game-a', { kind: 'ref', name: 'novelai' })).toBe(ref);
	expect(readFileSync(join(directory, 'game-secrets.sqlite')).includes(Buffer.from(value))).toBe(
		false
	);
	store.request('game-a', { kind: 'set', name: 'novelai', value: 'replacement-test-secret', url });
	expect(() => store.authorize('game-a', url, [['authorization', ref]])).toThrow();
	store.request('game-a', { kind: 'remove', name: 'novelai' });
	expect(store.request('game-a', { kind: 'has', name: 'novelai' })).toBe(false);
	expect(store.request('game-b', { kind: 'has', name: 'novelai' })).toBe(true);
});
it('cannot read, use, overwrite or delete model keys or service accounts, even with identical names', async () => {
	const providers = openCredentialStore(
		join(directory, 'credentials.sqlite'),
		join(directory, 'secrets', 'provider.key')
	);
	const model = { id: 'same-name', kind: 'openai-compatible', baseUrl: 'https://api.example' };
	const vertex = {
		id: 'service-account',
		kind: 'google-vertex',
		baseUrl:
			'https://aiplatform.googleapis.com/v1/projects/helia-test-project/locations/global/publishers/google',
		vertex: { projectId: 'helia-test-project', location: 'global' }
	};
	try {
		await providers.request({
			kind: 'save',
			provider: model,
			apiKey: 'private-model-key-not-real'
		});
		await providers.request({
			kind: 'save',
			provider: vertex,
			serviceAccountJson: JSON.stringify(fixture)
		});
		for (const name of [model.id, vertex.id]) {
			expect(store.request('game-a', { kind: 'has', name })).toBe(false);
			expect(() => store.request('game-a', { kind: 'ref', name })).toThrow();
			store.request('game-a', { kind: 'remove', name });
			store.request('game-a', { kind: 'set', name, value, url });
			store.request('game-a', { kind: 'remove', name });
		}
		expect(await providers.request({ kind: 'status', providers: [model, vertex] })).toEqual({
			'same-name': true,
			'service-account': true
		});
		expect(() => store.request('game-a', { kind: 'get', name: model.id })).toThrow();
		expect(() =>
			store.request('game-a', { kind: 'has', name: model.id, gameId: 'other' })
		).toThrow();
		for (const name of ['../credentials', '/master.key', '__proto__']) {
			expect(() => store.request('game-a', { kind: 'has', name })).toThrow();
		}
	} finally {
		providers.close();
	}
});
it('does not replace encrypted records when the key file is missing or wrong', () => {
	store.request('game-a', { kind: 'set', name: 'token', value, url });
	const path = join(directory, 'secrets', 'game.key'),
		key = readFileSync(path);
	writeFileSync(path, Buffer.alloc(32, 7));
	expect(() =>
		store.request('game-b', { kind: 'set', name: 'token', value: 'replacement', url })
	).toThrow('Game secret unavailable');
	writeFileSync(path, key);
	expect(store.request('game-a', { kind: 'has', name: 'token' })).toBe(true);
	expect(store.request('game-b', { kind: 'has', name: 'token' })).toBe(false);
});
it('accepts only same-origin secret requests and never accepts a scope override in the operation', async () => {
	const call = (body: unknown, origin = 'http://localhost') =>
		POST({
			request: new Request('http://localhost/api/games/game-a/secrets', {
				method: 'POST',
				headers: { origin, 'content-type': 'application/json' },
				body: JSON.stringify(body)
			}),
			url: new URL('http://localhost/api/games/game-a/secrets'),
			params: { id: 'game-a' }
		} as Parameters<typeof POST>[0]);
	expect((await call({ kind: 'set', name: 'token', value, url })).status).toBe(200);
	expect(await (await call({ kind: 'has', name: 'token' })).json()).toEqual({ result: true });
	expect((await call({ kind: 'remove', name: 'token' }, 'https://attacker.example')).status).toBe(
		403
	);
	expect((await call({ kind: 'has', name: 'token', gameId: 'game-b' })).status).toBe(400);
	expect(
		(await call({ kind: 'set', name: 'token', value, url: 'http://api.example' })).status
	).toBe(400);
	expect(store.request('game-a', { kind: 'has', name: 'token' })).toBe(true);
});
it('blocks reflected secrets split across binary chunks without altering safe image bytes', () => {
	const guard = new SecretResponseGuard([value]);
	expect(guard.push(Buffer.from('safe ' + value.slice(0, 10))).length).toBeLessThanOrEqual(5);
	expect(() => guard.push(Buffer.from(value.slice(10)))).toThrow();
	const binary = Uint8Array.from([0, 255, 254, 1, 2, 3, 0, 200]),
		safe = new SecretResponseGuard([value]);
	expect(Buffer.concat([safe.push(binary), safe.push(new Uint8Array(), true)])).toEqual(
		Buffer.from(binary)
	);
	expect(() => safe.headers([['x-reflected', value]])).toThrow();
});

it('resolves the game reference at the final HTTP hop and blocks reflected credentials in responses', async () => {
	store.request('game-a', { kind: 'set', name: 'token', value, url });
	const reference = store.request('game-a', { kind: 'ref', name: 'token' });
	const send = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
		expect(new Headers(options?.headers).get('authorization')).toBe('Bearer ' + value);
		return Response.json({ ok: true });
	});
	vi.stubGlobal('fetch', send);
	const call = (gameId = 'game-a') =>
		networkPOST({
			request: new Request('http://localhost/api/network', {
				method: 'POST',
				headers: { origin: 'http://localhost', 'content-type': 'application/json' },
				body: JSON.stringify({
					gameId,
					url,
					method: 'GET',
					headers: [['authorization', 'Bearer ' + reference]],
					body: null
				})
			}),
			url: new URL('http://localhost/api/network')
		} as Parameters<typeof networkPOST>[0]);
	const response = await call();
	expect(await response.text()).toContain('"kind":"end"');
	expect(send).toHaveBeenCalledOnce();
	expect((await call('game-b')).status).toBe(400);
	expect(send).toHaveBeenCalledOnce();
	send.mockResolvedValue(Response.json({ reflected: value }));
	const failed = await (await call()).text();
	expect(failed).toContain('"kind":"error"');
	expect(failed).not.toContain('"kind":"chunk"');
});
