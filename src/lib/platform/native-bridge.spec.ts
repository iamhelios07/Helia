import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

const builder = readFileSync(new URL('../../../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const storage = readFileSync(new URL('../../../src-tauri/src/storage.rs', import.meta.url), 'utf8');
const mediaServer = readFileSync(
	new URL('../../../src-tauri/src/media_server.rs', import.meta.url),
	'utf8'
);
const token = 'test-process-token';
const mediaBase = `http://127.0.0.1:43210/${'a'.repeat(64)}`;
const template = storage.match(/r#"(;\(\(\) => \{\{[\s\S]*?)"#,/)!;
const script = template[1]
	.replaceAll('{{', '{')
	.replaceAll('}}', '}')
	.replace('"{}"', JSON.stringify(token));
const mediaTemplate = mediaServer.match(/r#"(;\(\(\) => \{\{[\s\S]*?)"#,/)!;
const mediaScript = mediaTemplate[1]
	.replaceAll('{{', '{')
	.replaceAll('}}', '}')
	.replace('"{}"', JSON.stringify(mediaBase));

function boot(child = false) {
	const invoke = vi.fn(async () => ({ ok: true }));
	const window: Record<string, unknown> = { __TAURI_INTERNALS__: { plugins: {} } };
	window.top = child ? {} : window;
	// Tauri runs invoke initialization before core.js installs invoke. Plugin init runs after it.
	// Follow the actual native builder hook so an early-hook regression exercises the failure.
	if (builder.includes('.append_invoke_initialization_script(initialization)')) {
		runInNewContext(script, { window });
	}
	const internals = window.__TAURI_INTERNALS__ as Record<string, unknown>;
	internals.invoke = invoke;
	if (builder.includes('.js_init_script(initialization)')) {
		runInNewContext(script, { window });
	}
	if (builder.includes('.js_init_script(media_initialization)')) {
		runInNewContext(mediaScript, { window });
	}
	return { window, internals, invoke };
}

it('captures the ready native invoker for storage, settings, credentials and AI before application code runs', async () => {
	const { window, internals, invoke } = boot();
	const credentials = window.__HELIA_CREDENTIALS__ as (request: unknown) => Promise<unknown>;
	await expect(credentials({ kind: 'status', providers: [] })).resolves.toEqual({ ok: true });
	// The host token must stay bound to the trusted original invoker.
	internals.invoke = vi.fn(() => {
		throw Error('Replaced invoker must not receive the token');
	});
	const request = { kind: 'read' };
	await (window.__HELIA_STORAGE__ as (request: unknown) => Promise<unknown>)(request);
	await (window.__HELIA_AI_SETTINGS__ as (request: unknown) => Promise<unknown>)(request);
	await (window.__HELIA_AI__ as (request: unknown, chunk: unknown) => Promise<unknown>)(request, 1);
	await (window.__HELIA_NETWORK__ as (request: unknown, chunk: unknown) => Promise<unknown>)(
		request,
		2
	);
	expect(invoke.mock.calls).toEqual([
		['credential_request', { request: { kind: 'status', providers: [] }, token }],
		['storage_request', { request, token }],
		['ai_settings_request', { request, token }],
		['ai_request', { request, onChunk: 1, token }],
		['network_request', { request, onChunk: 2, token }]
	]);
	expect(window.token).toBeUndefined();
	expect(Object.getOwnPropertyDescriptor(window, '__HELIA_CREDENTIALS__')).toMatchObject({
		writable: false,
		configurable: false
	});
	expect(window.__HELIA_MEDIA_BASE__).toBe(mediaBase);
	expect(Object.getOwnPropertyDescriptor(window, '__HELIA_MEDIA_BASE__')).toMatchObject({
		writable: false,
		configurable: false
	});
});

it('never installs native bridges in a child frame', () => {
	const { window } = boot(true);
	expect(window.__HELIA_STORAGE__).toBeUndefined();
	expect(window.__HELIA_AI_SETTINGS__).toBeUndefined();
	expect(window.__HELIA_CREDENTIALS__).toBeUndefined();
	expect(window.__HELIA_AI__).toBeUndefined();
	expect(window.__HELIA_NETWORK__).toBeUndefined();
	expect(window.__HELIA_MEDIA_BASE__).toBeUndefined();
});
