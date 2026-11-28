import { afterEach, expect, it, vi } from 'vitest';

import minimalRelease from '#lib/games/package/fixtures/minimal-release.json';
import { GamePackageError, isGamePackageErrorCode } from '#lib/games/package/limits.js';
import errorCodes from '#lib/storage/fixtures/install/error-codes.json';

import installRequestLimit from './install-request-limit.json';

const flags = vi.hoisted(() => ({ desktop: false, native: false }));
const nativeInvoke = vi.hoisted(() => vi.fn());
const uploadDocumentBody = vi.hoisted(() => vi.fn());
vi.mock('#lib/platform/index.js', () => ({
	get isDesktopBuild() {
		return flags.desktop;
	},
	isTauri: () => flags.native
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: nativeInvoke }));
vi.mock('./media-transfer.js', () => ({ uploadDocumentBody }));
import { DOCUMENT_OPERATION_LIMITS } from '#lib/games/versioning-validation.js';

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
		expect.objectContaining({
			method: 'POST',
			body: '{"kind":"sync","request":{"kind":"list"},"known":[]}'
		})
	);
});
it('preserves conflict errors so the repository can retry', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn().mockResolvedValue(Response.json({ error: 'STORAGE_CONFLICT' }, { status: 409 }))
	);
	await expect(storageRequest({ kind: 'list' })).rejects.toThrow('STORAGE_CONFLICT');
});

it.each([false, true])(
	'splits an oversized save into a document upload and preserves input (desktop=%s)',
	async (desktop) => {
		flags.desktop = desktop;
		flags.native = desktop;
		uploadDocumentBody.mockResolvedValue('helia-upload:doc');
		const host = vi.fn().mockResolvedValue({ version: 1, records: [] });
		const fetch = vi.fn().mockResolvedValue(Response.json({ version: 1, records: [] }));
		const view = { __HELIA_STORAGE__: host };
		Object.assign(view, { top: view });
		vi.stubGlobal('window', view);
		vi.stubGlobal('fetch', fetch);
		const padding = '한\0'.repeat(3 * 1024 * 1024);
		const gameId = 'large-save-' + desktop;
		const request = {
			kind: 'commit' as const,
			gameId,
			version: 0,
			deleteSessions: [],
			records: [
				{
					table: 'games' as const,
					id: gameId,
					gameId,
					sessionId: null,
					value: { padding }
				}
			]
		};
		await storageRequest(request);
		expect(request.records[0].value.padding).toBe(padding);
		expect(uploadDocumentBody).toHaveBeenCalledWith(gameId, 'commit', expect.any(String));
		const stub = {
			kind: 'sync',
			request: { kind: 'commit', gameId, bodyRef: 'helia-upload:doc' },
			known: []
		};
		if (desktop) {
			expect(host).toHaveBeenCalledWith(stub);
			expect(fetch).not.toHaveBeenCalled();
		} else {
			expect(fetch).toHaveBeenCalledWith(
				'/api/storage',
				expect.objectContaining({ body: JSON.stringify(stub) })
			);
			expect(host).not.toHaveBeenCalled();
		}
	}
);
it.each([false, true])(
	'keeps a small save on the inline path without a document upload (desktop=%s)',
	async (desktop) => {
		flags.desktop = desktop;
		flags.native = desktop;
		const host = vi.fn().mockResolvedValue({ version: 1, records: [] });
		const fetch = vi.fn().mockResolvedValue(Response.json({ version: 1, records: [] }));
		const view = { __HELIA_STORAGE__: host };
		Object.assign(view, { top: view });
		vi.stubGlobal('window', view);
		vi.stubGlobal('fetch', fetch);
		const gameId = 'small-save-' + desktop;
		const request = {
			kind: 'commit' as const,
			gameId,
			version: 0,
			deleteSessions: [],
			records: [
				{
					table: 'games' as const,
					id: gameId,
					gameId,
					sessionId: null,
					value: { padding: 'hello' }
				}
			]
		};
		await storageRequest(request);
		expect(uploadDocumentBody).not.toHaveBeenCalled();
		const sent = desktop ? host.mock.calls[0][0] : JSON.parse(fetch.mock.calls[0][1].body);
		expect(sent.request.records[0].value.padding).toBe('hello');
		expect(sent.request.bodyRef).toBeUndefined();
	}
);
it.each([false, true])(
	'rejects a save only above the commit operation budget (desktop=%s)',
	async (desktop) => {
		flags.desktop = desktop;
		flags.native = desktop;
		const host = vi.fn();
		const fetch = vi.fn();
		const view = { __HELIA_STORAGE__: host };
		Object.assign(view, { top: view });
		vi.stubGlobal('window', view);
		vi.stubGlobal('fetch', fetch);
		const padding = 'x'.repeat(Number(DOCUMENT_OPERATION_LIMITS.commit));
		const request = {
			kind: 'commit' as const,
			gameId: 'cap-save',
			version: 0,
			deleteSessions: [],
			records: [
				{
					table: 'games' as const,
					id: 'cap-save',
					gameId: 'cap-save',
					sessionId: null,
					value: { padding }
				}
			]
		};
		await expect(storageRequest(request)).rejects.toThrow('저장할 내용이 너무 커요');
		expect(request.records[0].value.padding).toBe(padding);
		expect(uploadDocumentBody).not.toHaveBeenCalled();
		expect(host).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	},
	60000
);
it.each([false, true])(
	'uses the exact UTF-8 8 MiB split boundary and keeps 8–20 MiB create inline (desktop=%s)',
	async (desktop) => {
		flags.desktop = desktop;
		flags.native = desktop;
		uploadDocumentBody.mockResolvedValue('helia-upload:doc');
		const host = vi.fn().mockResolvedValue({ version: 1, records: [] });
		const fetch = vi
			.fn()
			.mockImplementation(async () => Response.json({ version: 1, records: [] }));
		const view = { __HELIA_STORAGE__: host };
		Object.assign(view, { top: view });
		vi.stubGlobal('window', view);
		vi.stubGlobal('fetch', fetch);
		for (const [kind, size, split] of [
			['commit', 8 * 1024 * 1024, false],
			['commit', 8 * 1024 * 1024 + 1, true],
			['create', 12 * 1024 * 1024, false]
		] as const) {
			const request = {
				kind,
				gameId: `boundary-${desktop}-${size}`,
				version: 0,
				records: [],
				deleteSessions: [],
				padding: '한\0'
			};
			const byteLength = () => new TextEncoder().encode(JSON.stringify(request)).length;
			request.padding += 'x'.repeat(size - byteLength());
			expect(byteLength()).toBe(size);
			uploadDocumentBody.mockClear();
			await storageRequest(request);
			const sent = desktop ? host.mock.lastCall![0] : JSON.parse(fetch.mock.lastCall![1].body);
			if (split) {
				expect(uploadDocumentBody).toHaveBeenCalledWith(
					request.gameId,
					'commit',
					JSON.stringify(request)
				);
				expect(sent.request).toEqual({ kind, gameId: request.gameId, bodyRef: 'helia-upload:doc' });
			} else {
				expect(uploadDocumentBody).not.toHaveBeenCalled();
				expect(sent.request).toEqual(request);
			}
		}
	}
);
it.each(errorCodes)(
	'restores web 400 package error %s with its stable local message',
	async (code) => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					Response.json({ error: 'untrusted host message', errorCode: code }, { status: 400 })
				)
		);
		expect(isGamePackageErrorCode(code)).toBe(true);
		if (!isGamePackageErrorCode(code)) {
			throw Error('Unknown shared error code');
		}
		const error = await storageRequest({
			kind: 'installPreview',
			originalGameId: '12345678-1234-4234-8234-123456789abc',
			contentVersion: '1.0.0'
		}).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(GamePackageError);
		expect(error).toMatchObject({ code, message: new GamePackageError(code).message });
	}
);
it.each(['unknown', 'constructor', '__proto__', 1, null])(
	'keeps unknown package error code %j as an ordinary transport error',
	async (errorCode) => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(Response.json({ error: 'Rejected', errorCode }, { status: 400 }))
		);
		const error = await storageRequest({ kind: 'list' }).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(GamePackageError);
		expect(error).toMatchObject({ message: 'Rejected' });
	}
);
it('handles non-JSON error responses without leaking a parser error', async () => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Bad gateway', { status: 502 })));
	await expect(storageRequest({ kind: 'list' })).rejects.toThrow('게임 저장소를 사용할 수 없어요.');
});
it('routes desktop requests to the single host command', async () => {
	flags.desktop = true;
	flags.native = true;
	const host = vi.fn().mockResolvedValue({ version: 0, records: [] });
	const main = { __HELIA_STORAGE__: host };
	Object.assign(main, { top: main });
	vi.stubGlobal('window', main);
	expect(await storageRequest({ kind: 'list' })).toEqual({ version: 0, records: [] });
	expect(host).toHaveBeenCalledWith({ kind: 'sync', request: { kind: 'list' }, known: [] });
	expect(nativeInvoke).not.toHaveBeenCalled();
});

it('shows a native resource budget rejection with its count and size', async () => {
	flags.desktop = true;
	flags.native = true;
	const message = '리소스 목록이 너무 커요(항목 80000개, 약 16.1 MiB)';
	const host = vi.fn().mockRejectedValue(message);
	const view = { __HELIA_STORAGE__: host };
	Object.assign(view, { top: view });
	vi.stubGlobal('window', view);
	await expect(
		storageRequest({
			kind: 'versioning',
			gameId: 'oversized',
			action: 'release',
			contentVersion: '1.0.0'
		})
	).rejects.toThrow(message);
});

it('retains a web resource budget message even when wrapped in a package limit error', async () => {
	const message = '리소스 목록이 너무 커요(항목 80000개, 약 16.1 MiB)';
	vi.stubGlobal(
		'fetch',
		vi
			.fn()
			.mockResolvedValue(Response.json({ error: message, errorCode: 'limit' }, { status: 400 }))
	);
	await expect(
		storageRequest({
			kind: 'installPreview',
			originalGameId: minimalRelease.originalGameId,
			contentVersion: '1.0.0'
		})
	).rejects.toThrow(message);
});

it.each([false, true])(
	'checks supplied install preview resources before sending (desktop=%s)',
	async (desktop) => {
		flags.desktop = desktop;
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		const request = {
			kind: 'installPreview' as const,
			originalGameId: minimalRelease.originalGameId,
			contentVersion: '1.0.0',
			release: {
				content: {
					resources: {
						image: {
							name: 'x'.repeat(16 * 1024 * 1024),
							mime: 'image/png',
							data: 'helia-asset:' + 'a'.repeat(64)
						}
					}
				}
			}
		};
		await expect(storageRequest(request)).rejects.toThrow('리소스 목록이 너무 커요(항목 1개');
		expect(fetch).not.toHaveBeenCalled();
	}
);
it.each(errorCodes)(
	'restores native package error %s with the stable local message',
	async (code) => {
		flags.desktop = true;
		flags.native = true;
		const host = vi.fn().mockRejectedValue({ errorCode: code });
		const main = { __HELIA_STORAGE__: host };
		Object.assign(main, { top: main });
		vi.stubGlobal('window', main);
		const error = await storageRequest({
			kind: 'installPreview',
			originalGameId: minimalRelease.originalGameId,
			contentVersion: '1.0.0'
		}).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(GamePackageError);
		expect(error).toMatchObject({ code });
	}
);
it('checks the desktop install UTF-8 size before invoking the host at the exact limit and +1', async () => {
	flags.desktop = true;
	flags.native = true;
	const host = vi.fn().mockResolvedValue({ version: 0, records: [] });
	const main = { __HELIA_STORAGE__: host };
	Object.assign(main, { top: main });
	vi.stubGlobal('window', main);
	const request = {
		kind: 'install' as const,
		gameId: '12345678-1234-4234-8234-123456789abd',
		sessionId: '12345678-1234-4234-8234-123456789abe',
		packageFormatVersion: 1 as const,
		release: minimalRelease,
		padding: '한\u0000'
	};
	const size = () => new TextEncoder().encode(JSON.stringify(request)).length;
	request.padding += 'x'.repeat(installRequestLimit - size());
	expect(size()).toBe(installRequestLimit);
	await storageRequest(request);
	expect(host).toHaveBeenCalledTimes(1);
	request.padding += 'x';
	expect(size()).toBe(installRequestLimit + 1);
	await expect(storageRequest(request)).rejects.toMatchObject({ code: 'limit' });
	expect(host).toHaveBeenCalledTimes(1);
});
it('uses the private JSON envelope only for native install requests', async () => {
	flags.desktop = true;
	flags.native = true;
	const host = vi.fn().mockResolvedValue({ version: 0, records: [] });
	const main = { __HELIA_STORAGE__: host };
	Object.assign(main, { top: main });
	vi.stubGlobal('window', main);
	const request = {
		kind: 'install' as const,
		gameId: '12345678-1234-4234-8234-123456789abd',
		sessionId: '12345678-1234-4234-8234-123456789abe',
		packageFormatVersion: 1 as const,
		release: minimalRelease
	};
	await storageRequest(request);
	expect(host).toHaveBeenLastCalledWith({ kind: 'installJson', json: JSON.stringify(request) });
	const preview = {
		kind: 'installPreview' as const,
		originalGameId: minimalRelease.originalGameId,
		contentVersion: '1.0.0'
	};
	await storageRequest(preview);
	expect(host).toHaveBeenLastCalledWith(preview);
});
it.each(['STORAGE_CONFLICT', { errorCode: 'constructor' }, { errorCode: 'unknown' }])(
	'preserves ordinary native rejection %j',
	async (failure) => {
		flags.desktop = true;
		flags.native = true;
		const main = { __HELIA_STORAGE__: vi.fn().mockRejectedValue(failure) };
		Object.assign(main, { top: main });
		vi.stubGlobal('window', main);
		await expect(storageRequest({ kind: 'list' })).rejects.toEqual(failure);
	}
);
it('refuses raw native access without the trusted main-frame closure', async () => {
	flags.desktop = true;
	flags.native = true;
	vi.stubGlobal('window', { top: {} });
	await expect(storageRequest({ kind: 'list' })).rejects.toThrow(
		'데스크톱 저장소 접근이 허용되지 않았어요.'
	);
	expect(nativeInvoke).not.toHaveBeenCalled();
});
it('does not silently use web storage in desktop browser previews', async () => {
	flags.desktop = true;
	await expect(storageRequest({ kind: 'list' })).rejects.toThrow(
		'데스크톱 저장소는 Helia 앱에서 사용할 수 있어요.'
	);
	expect(nativeInvoke).not.toHaveBeenCalled();
});
