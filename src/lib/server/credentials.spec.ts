import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openCredentialStore } from './credentials.js';
import fixture from '#lib/testing/fixtures/service-account.json';
import { vertexBaseUrl } from '#lib/app/settings/vertex.js';

let directory: string;
let filename: string;
let keyPath: string;
let store: ReturnType<typeof openCredentialStore>;
const provider = {
	id: 'test-connection',
	kind: 'openai-compatible',
	baseUrl: 'https://example.com/v1'
};
const apiKey = 'test-only-secret-not-a-real-api-key';
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'helia-credentials-'));
	filename = join(directory, 'credentials.sqlite');
	keyPath = join(directory, 'secrets', 'master.key');
	store = openCredentialStore(filename, keyPath);
});
afterEach(() => {
	store.close();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	if (
		!resolve(directory).startsWith(resolve(tmpdir()) + '\\helia-credentials-') &&
		!resolve(directory).startsWith(resolve(tmpdir()) + '/helia-credentials-')
	)
		throw new Error('Unexpected test cleanup path');
	rmSync(directory, { recursive: true, force: true });
});

it('persists encrypted keys across reopen and returns only status or sanitized model metadata', async () => {
	await store.request({ kind: 'save', provider, apiKey });
	const key = readFileSync(keyPath);
	expect(key.length).toBe(32);
	store.close();
	store = openCredentialStore(filename, keyPath);
	expect(await store.request({ kind: 'status', providers: [provider] })).toEqual({
		[provider.id]: true
	});
	const send = vi.fn().mockResolvedValue(Response.json({ data: [{ id: 'model-one' }] }));
	vi.stubGlobal('fetch', send);
	expect(await store.request({ kind: 'models', provider })).toEqual([
		{ id: 'model-one', name: 'model-one' }
	]);
	expect(send.mock.calls[0][1].headers.authorization).toBe(`Bearer ${apiKey}`);
	expect(readFileSync(keyPath)).toEqual(key);
	store.close();
	store = openCredentialStore(filename, keyPath);
	expect(readFileSync(filename).includes(Buffer.from(apiKey))).toBe(false);
	if (process.platform === 'win32') {
		const result = execFileSync(
			'powershell.exe',
			[
				'-NoProfile',
				'-NonInteractive',
				'-Command',
				'$acl = Get-Acl -LiteralPath $env:HELIA_TEST_KEY; $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; ($acl.Access | Where-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]) -ne $sid }).Count -eq 0'
			],
			{ encoding: 'utf8', windowsHide: true, env: { ...process.env, HELIA_TEST_KEY: keyPath } }
		);
		expect(result.trim()).toBe('True');
	} else expect(statSync(keyPath).mode & 0o077).toBe(0);
});
it('does not regenerate a missing master key over existing credentials and allows explicit deletion and re-entry', async () => {
	await store.request({ kind: 'save', provider, apiKey });
	unlinkSync(keyPath);
	await expect(store.request({ kind: 'status', providers: [provider] })).rejects.toThrow(
		'암호화 키'
	);
	await expect(store.request({ kind: 'save', provider, apiKey: 'replacement' })).rejects.toThrow(
		'암호화 키'
	);
	expect(() => readFileSync(keyPath)).toThrow();
	await store.request({ kind: 'delete', id: provider.id });
	await store.request({ kind: 'save', provider, apiKey: 'explicit-replacement' });
	expect(await store.request({ kind: 'status', providers: [provider] })).toEqual({
		[provider.id]: true
	});
});
it('rejects a wrong key without overwriting encrypted data', async () => {
	await store.request({ kind: 'save', provider, apiKey });
	const original = readFileSync(keyPath);
	writeFileSync(keyPath, Buffer.alloc(32, 1));
	await expect(store.request({ kind: 'save', provider, apiKey: 'replacement' })).rejects.toThrow(
		'암호화 키'
	);
	writeFileSync(keyPath, original);
	expect(await store.request({ kind: 'status', providers: [provider] })).toEqual({
		[provider.id]: true
	});
});
it('binds keys to the saved endpoint and API format instead of forwarding them to edited addresses', async () => {
	await store.request({ kind: 'save', provider, apiKey });
	const send = vi.fn();
	vi.stubGlobal('fetch', send);
	const edited = { ...provider, baseUrl: 'https://other.example.com/v1' };
	expect(await store.request({ kind: 'status', providers: [edited] })).toEqual({
		[provider.id]: false
	});
	await expect(store.request({ kind: 'models', provider: edited })).rejects.toThrow('먼저 저장');
	expect(send).not.toHaveBeenCalled();
	await store.request({ kind: 'delete', id: provider.id });
	expect(await store.request({ kind: 'status', providers: [provider] })).toEqual({
		[provider.id]: false
	});
});
it('detects ciphertext copied between connection IDs', async () => {
	await store.request({ kind: 'save', provider, apiKey });
	const other = { ...provider, id: 'other-connection' };
	await store.request({ kind: 'save', provider: other, apiKey: 'other-secret' });
	const db = new Database(filename);
	db.prepare(
		'UPDATE credentials SET (nonce,tag,ciphertext) = (SELECT nonce,tag,ciphertext FROM credentials WHERE id = ?) WHERE id = ?'
	).run(provider.id, other.id);
	db.close();
	await expect(store.request({ kind: 'status', providers: [other] })).rejects.toThrow('암호화 키');
});

it('stores service-account JSON encrypted and verifies OAuth without returning keys or tokens', async () => {
	const vertex = {
		...provider,
		kind: 'google-vertex',
		vertex: { projectId: 'helia-test-project', location: 'global' },
		baseUrl: vertexBaseUrl('helia-test-project', 'global')
	};
	await store.request({
		kind: 'save',
		provider: vertex,
		serviceAccountJson: JSON.stringify(fixture)
	});
	expect(await store.request({ kind: 'status', providers: [vertex] })).toEqual({
		[provider.id]: true
	});
	expect(
		await store.request({
			kind: 'status',
			providers: [{ ...vertex, vertex: { ...vertex.vertex, location: 'us-central1' } }]
		})
	).toEqual({ [provider.id]: false });
	const send = vi.fn().mockImplementation(async () =>
		Response.json({
			access_token: 'never-return-access-token',
			expires_in: 3600,
			token_type: 'Bearer'
		})
	);
	vi.stubGlobal('fetch', send);
	expect(await store.request({ kind: 'verify', provider: vertex })).toEqual({ verified: true });
	expect(await store.request({ kind: 'verify', provider: vertex })).toEqual({ verified: true });
	expect(send).toHaveBeenCalledTimes(1);
	expect(send.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token');
	send.mockClear();
	await expect(store.request({ kind: 'models', provider: vertex })).rejects.toThrow(
		'모델 ID를 직접'
	);
	expect(send).not.toHaveBeenCalled();
	store.close();
	store = openCredentialStore(filename, keyPath);
	expect(await store.request({ kind: 'status', providers: [vertex] })).toEqual({
		[provider.id]: true
	});
	expect(readFileSync(filename).includes(Buffer.from('BEGIN PRIVATE KEY'))).toBe(false);
	expect(readFileSync(filename).includes(Buffer.from('never-return-access-token'))).toBe(false);
	await expect(
		store.request({
			kind: 'save',
			provider: vertex,
			serviceAccountJson: JSON.stringify({
				...fixture,
				private_key: '-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----\n'
			})
		})
	).rejects.toThrow('RSA 개인 키');
	expect(await store.request({ kind: 'status', providers: [vertex] })).toEqual({
		[provider.id]: true
	});
});
