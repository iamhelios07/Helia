import { afterEach, expect, it, vi } from 'vitest';

const flags = vi.hoisted(() => ({ desktop: false, native: false }));
const nativeInvoke = vi.hoisted(() => vi.fn());
vi.mock('#lib/platform/index.js', () => ({
	get isDesktopBuild() {
		return flags.desktop;
	},
	isTauri: () => flags.native
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: nativeInvoke }));
import { storageRequest } from './transport.js';

afterEach(() => {
	flags.desktop = false;
	flags.native = false;
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});
it('sends only the typed request to the web endpoint', async () => {
	const fetch = vi.fn().mockResolvedValue(Response.json({ version: 0, records: [] }));
	vi.stubGlobal('fetch', fetch);
	expect(await storageRequest({ kind: 'list' })).toEqual({ version: 0, records: [] });
	expect(fetch).toHaveBeenCalledWith(
		'/api/storage',
		expect.objectContaining({ method: 'POST', body: '{"kind":"list"}' })
	);
});
it('preserves conflict errors so the repository can retry', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn().mockResolvedValue(Response.json({ error: 'STORAGE_CONFLICT' }, { status: 409 }))
	);
	await expect(storageRequest({ kind: 'list' })).rejects.toThrow('STORAGE_CONFLICT');
});
it('handles non-JSON error responses without leaking a parser error', async () => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Bad gateway', { status: 502 })));
	await expect(storageRequest({ kind: 'list' })).rejects.toThrow('게임 저장소를 사용할 수 없어요.');
});
it('routes desktop requests to the single host command', async () => {
	flags.desktop = true;
	flags.native = true;
	nativeInvoke.mockResolvedValue({ version: 0, records: [] });
	expect(await storageRequest({ kind: 'list' })).toEqual({ version: 0, records: [] });
	expect(nativeInvoke).toHaveBeenCalledWith('storage_request', { request: { kind: 'list' } });
});
it('does not silently use web storage in desktop browser previews', async () => {
	flags.desktop = true;
	await expect(storageRequest({ kind: 'list' })).rejects.toThrow(
		'데스크톱 저장소는 Helia 앱에서 사용할 수 있어요.'
	);
	expect(nativeInvoke).not.toHaveBeenCalled();
});
