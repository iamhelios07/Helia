import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { sessionFiles } from './client.js';

const platform = vi.hoisted(() => ({ desktop: false }));
vi.mock('#lib/platform/index.js', () => ({
	get isDesktopBuild() {
		return platform.desktop;
	},
	isTauri: () => true
}));
beforeEach(() => {
	platform.desktop = false;
});
afterEach(() => {
	vi.unstubAllGlobals();
});
const info = {
	ref: 'helia-file:00000000-0000-4000-8000-000000000001',
	name: 'file.bin',
	mime: 'application/octet-stream',
	size: 3,
	createdAt: '2026-11-19T00:00:00.000Z'
};
const scope = { gameId: 'game', sessionId: 'session' };

it('sends binary web uploads and returns bounded bytes and metadata', async () => {
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(Response.json(info))
		.mockResolvedValueOnce(
			new Response(Uint8Array.of(0, 1, 255), { headers: { 'content-type': info.mime } })
		)
		.mockResolvedValueOnce(Response.json({ files: [info], nextCursor: null }))
		.mockResolvedValueOnce(Response.json({ error: 'FILE_NOT_FOUND' }, { status: 404 }));
	vi.stubGlobal('fetch', fetch);
	const files = sessionFiles(scope);
	const blob = new Blob([Uint8Array.of(0, 1, 255)]);
	expect(await files.save(blob, { name: info.name })).toEqual(info);
	expect(fetch.mock.calls[0][1].body).toBe(blob);
	expect([...new Uint8Array(await (await files.read(info.ref)).arrayBuffer())]).toEqual([
		0, 1, 255
	]);
	expect(await files.list()).toEqual({ files: [info], nextCursor: null });
	await expect(files.stat(info.ref)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
});
it('uses the main-frame native bridge with base64 only at the native transport boundary', async () => {
	platform.desktop = true;
	const host = vi
		.fn()
		.mockResolvedValueOnce(info)
		.mockResolvedValueOnce({ info, data: 'AAH/' })
		.mockRejectedValueOnce('FILE_QUOTA');
	const window = { top: undefined as unknown, __HELIA_STORAGE__: host };
	window.top = window;
	vi.stubGlobal('window', window);
	const fetch = vi.fn();
	vi.stubGlobal('fetch', fetch);
	const files = sessionFiles(scope);
	expect(await files.save(new Blob([Uint8Array.of(0, 1, 255)]), { name: info.name })).toEqual(info);
	expect(host.mock.calls[0][0]).toEqual({
		kind: 'files',
		...scope,
		operation: { kind: 'save', name: info.name, mime: info.mime, size: 3, data: 'AAH/' }
	});
	expect([...new Uint8Array(await (await files.read(info.ref)).arrayBuffer())]).toEqual([
		0, 1, 255
	]);
	await expect(files.save(new Blob())).rejects.toMatchObject({ code: 'FILE_QUOTA' });
	window.top = {};
	await expect(files.list()).rejects.toMatchObject({ code: 'FILE_UNAVAILABLE' });
	expect(host).toHaveBeenCalledTimes(3);
	expect(fetch).not.toHaveBeenCalled();
});
