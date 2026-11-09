import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { emptyAISettings } from '#lib/app/settings/model.js';
import { aiSettingsStorage } from '#lib/server/ai-settings.js';

import { GET, POST, PUT } from './+server.js';

const server = vi.hoisted(() => ({ connection: undefined as Database.Database | undefined }));
vi.mock('#lib/server/sqlite.js', () => ({ serverStorage: () => server }));
const url = new URL('http://localhost/api/ai-settings');
type Handler = typeof GET;
interface CallOptions {
	origin?: string | null;
	contentType?: string | null;
	site?: string;
	body?: string;
}
function call(method: 'GET' | 'POST' | 'PUT', options: CallOptions = {}) {
	const headers = new Headers();
	const origin = options.origin === undefined ? url.origin : options.origin;
	const contentType = options.contentType === undefined ? 'application/json' : options.contentType;
	if (origin !== null) {
		headers.set('origin', origin);
	}
	if (contentType !== null) {
		headers.set('content-type', contentType);
	}
	if (options.site) {
		headers.set('sec-fetch-site', options.site);
	}
	const request = new Request(url, {
		method,
		headers,
		...(method === 'GET'
			? {}
			: { body: options.body ?? JSON.stringify({ settings: emptyAISettings() }) })
	});
	const handler: Handler = { GET, POST, PUT }[method];
	return handler({ request, url } as Parameters<Handler>[0]);
}
function storage() {
	return aiSettingsStorage(server.connection!);
}
beforeEach(() => {
	server.connection = new Database(':memory:');
	vi.stubEnv('HELIA_ORIGIN', url.origin);
});
afterEach(() => {
	server.connection?.close();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

it('loads absent or saved settings and atomically initializes without overwriting existing data', async () => {
	const initial = await call('GET', { origin: null });
	expect(await initial.json()).toEqual({ settings: null, revision: 0 });
	const saved = await call('POST');
	expect(await saved.json()).toEqual({ settings: emptyAISettings(), revision: 1 });
	const later = await call('POST');
	expect(await later.json()).toEqual({ settings: emptyAISettings(), revision: 1 });
	expect(await (await call('GET')).json()).toEqual({ settings: emptyAISettings(), revision: 1 });
	for (const response of [initial, saved, later]) {
		expect(response.headers.get('cache-control')).toBe('no-store');
	}
});

it('updates by revision and returns a safe 409 conflict for stale or absent snapshots', async () => {
	const body = JSON.stringify({ settings: emptyAISettings(), revision: 1 });
	expect((await call('PUT', { body })).status).toBe(409);
	await call('POST');
	const updated = await call('PUT', { body });
	expect(await updated.json()).toEqual({ settings: emptyAISettings(), revision: 2 });
	const stale = await call('PUT', { body });
	expect(stale.status).toBe(409);
	expect(await stale.json()).toEqual({
		error: '다른 창에서 모델 설정이 변경됐어요. 설정을 다시 불러온 후 저장해주세요.'
	});
	expect(stale.headers.get('cache-control')).toBe('no-store');
	expect(storage().read().revision).toBe(2);
});

it.each(['GET', 'POST', 'PUT'] as const)(
	'rejects opaque, cross-origin and cross-site %s requests with no-store',
	async (method) => {
		for (const options of [
			{ origin: 'null' },
			{ origin: 'https://other.example' },
			{ origin: url.origin, site: 'cross-site' },
			{ origin: null, site: 'cross-site' }
		]) {
			const response = await call(method, options);
			expect(response.status).toBe(403);
			expect(response.headers.get('cache-control')).toBe('no-store');
		}
		expect(storage().read()).toEqual({ settings: null, revision: 0 });
	}
);

it.each(['POST', 'PUT'] as const)(
	'requires same Origin and JSON media type on %s',
	async (method) => {
		for (const options of [
			{ origin: null },
			{ contentType: null },
			{ contentType: 'text/plain' },
			{ contentType: 'application/json-evil' }
		]) {
			expect((await call(method, options)).status).toBe(403);
		}
		expect(storage().read().settings).toBeNull();
	}
);

it('uses the configured public origin and accepts JSON charset parameters', async () => {
	vi.stubEnv('HELIA_ORIGIN', 'https://helia.example');
	expect((await call('GET')).status).toBe(403);
	expect((await call('POST')).status).toBe(403);
	expect((await call('GET', { origin: 'https://helia.example' })).status).toBe(200);
	expect(
		(
			await call('POST', {
				origin: 'https://helia.example',
				contentType: 'application/json; charset=utf-8'
			})
		).status
	).toBe(200);
});

it.each(['POST', 'PUT'] as const)(
	'rejects malformed and invalid settings bodies on %s',
	async (method) => {
		for (const value of [
			'invalid',
			'null',
			'[]',
			'{}',
			'{"settings":null}',
			'{"settings":{"version":2}}'
		]) {
			const response = await call(method, { body: value });
			expect(response.status).toBe(400);
			expect(response.headers.get('cache-control')).toBe('no-store');
		}
		expect(storage().read()).toEqual({ settings: null, revision: 0 });
	}
);

it.each([undefined, null, '1', -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
	'rejects missing or invalid PUT revision %s',
	async (revision) => {
		await call('POST');
		const response = await call('PUT', {
			body: JSON.stringify({ settings: emptyAISettings(), revision })
		});
		expect(response.status).toBe(400);
		expect(storage().read().revision).toBe(1);
	}
);

it.each(['POST', 'PUT'] as const)(
	'enforces an exact 1MiB UTF-8 JSON byte limit on %s',
	async (method) => {
		await call('POST');
		const base = JSON.stringify({ settings: emptyAISettings(), revision: 1, padding: '' });
		const exact = base.replace(
			'"padding":""',
			`"padding":"${' '.repeat(1024 * 1024 - Buffer.byteLength(base))}"`
		);
		expect(Buffer.byteLength(exact)).toBe(1024 * 1024);
		expect((await call(method, { body: exact })).status).toBe(200);
		const excess = exact.replace('"padding":"', '"padding":"가');
		expect((await call(method, { body: excess })).status).toBe(400);
		expect(storage().read().revision).toBe(method === 'PUT' ? 2 : 1);
	}
);

it('strips secrets from requests, saved rows and read responses', async () => {
	const settings = {
		...emptyAISettings(),
		apiKey: 'never-save-secret',
		serviceAccount: 'private-secret'
	};
	const response = await call('POST', { body: JSON.stringify({ settings }) });
	expect(await response.json()).toEqual({ settings: emptyAISettings(), revision: 1 });
	const row = server.connection!.prepare('SELECT value FROM ai_settings').get() as {
		value: string;
	};
	expect(JSON.parse(row.value)).toEqual(emptyAISettings());
	expect(await (await call('GET')).text()).not.toContain('secret');
});

it.each(['GET', 'POST', 'PUT'] as const)(
	'hides all internal exception details on %s',
	async (method) => {
		vi.spyOn(server.connection!, 'exec').mockImplementation(() => {
			throw new Error('비밀 secret-token-in-error /private/database.sqlite');
		});
		const response = await call(method, {
			body: JSON.stringify({ settings: emptyAISettings(), revision: 1 })
		});
		expect(response.status).toBe(500);
		expect(response.headers.get('cache-control')).toBe('no-store');
		const body = await response.text();
		expect(body).not.toContain('secret-token');
		expect(body).not.toContain('/private/');
	}
);
