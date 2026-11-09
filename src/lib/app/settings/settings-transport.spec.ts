import { afterEach, expect, it, vi } from 'vitest';

import { emptyAISettings } from './model.js';
import { aiSettingsRequest } from './settings-transport.js';

const flags = vi.hoisted(() => ({ desktop: false, native: false }));
vi.mock('#lib/platform/index.js', () => ({
	get isDesktopBuild() {
		return flags.desktop;
	},
	isTauri: () => flags.native
}));

afterEach(() => {
	flags.desktop = false;
	flags.native = false;
	vi.unstubAllGlobals();
});

it('loads fresh settings with an uncached GET', async () => {
	const fetch = vi.fn().mockResolvedValue(Response.json({ settings: null, revision: 0 }));
	vi.stubGlobal('fetch', fetch);
	expect(await aiSettingsRequest({ kind: 'read' })).toEqual({ settings: null, revision: 0 });
	expect(fetch).toHaveBeenCalledWith('/api/ai-settings', { method: 'GET', cache: 'no-store' });
});

it.each([
	{ kind: 'initialize' as const, method: 'POST' },
	{ kind: 'write' as const, method: 'PUT' }
])(
	'uses $method for $kind with only non-secret settings and the expected revision',
	async (test) => {
		const settings = emptyAISettings();
		const fetch = vi.fn().mockResolvedValue(Response.json({ settings, revision: 2 }));
		vi.stubGlobal('fetch', fetch);
		const revision = test.kind === 'write' ? { revision: 1 } : {};
		await aiSettingsRequest(
			test.kind === 'write'
				? { kind: 'write', settings, revision: 1 }
				: { kind: 'initialize', settings }
		);
		expect(fetch).toHaveBeenCalledWith('/api/ai-settings', {
			method: test.method,
			cache: 'no-store',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ settings, ...revision })
		});
	}
);

it('preserves conflicts so stale clients cannot report a successful save', async () => {
	vi.stubGlobal(
		'fetch',
		vi
			.fn()
			.mockResolvedValue(Response.json({ error: '설정을 다시 불러와주세요.' }, { status: 409 }))
	);
	await expect(
		aiSettingsRequest({ kind: 'write', settings: emptyAISettings(), revision: 1 })
	).rejects.toThrow('설정을 다시 불러와주세요.');
});

it('reports non-JSON server failures without exposing response content', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn().mockResolvedValue(new Response('private diagnostics', { status: 502 }))
	);
	await expect(aiSettingsRequest({ kind: 'read' })).rejects.toThrow('모델 설정 저장소');
});

it.each([
	null,
	{},
	{ settings: null, revision: 1 },
	{ settings: emptyAISettings(), revision: 0 },
	{ settings: emptyAISettings(), revision: 1.5 },
	{ settings: { version: 2 }, revision: 1 }
])('validates host response shape and revision %#', async (reply) => {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(reply)));
	await expect(aiSettingsRequest({ kind: 'read' })).rejects.toThrow();
});

it('strips unexpected fields from host settings before displaying them', async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn().mockResolvedValue(
			Response.json({
				settings: { ...emptyAISettings(), apiKey: 'not-for-browser' },
				revision: 1
			})
		)
	);
	expect(await aiSettingsRequest({ kind: 'read' })).toEqual({
		settings: emptyAISettings(),
		revision: 1
	});
});

it('uses the private native settings bridge in the desktop main frame', async () => {
	flags.desktop = true;
	flags.native = true;
	const host = vi.fn().mockResolvedValue({ settings: emptyAISettings(), revision: 1 });
	const main = { __HELIA_AI_SETTINGS__: host };
	Object.assign(main, { top: main });
	vi.stubGlobal('window', main);
	expect(await aiSettingsRequest({ kind: 'read' })).toEqual({
		settings: emptyAISettings(),
		revision: 1
	});
	expect(host).toHaveBeenCalledWith({ kind: 'read' });
});

it('rejects native access from subframes', async () => {
	flags.desktop = true;
	flags.native = true;
	const host = vi.fn();
	vi.stubGlobal('window', { top: {}, __HELIA_AI_SETTINGS__: host });
	await expect(aiSettingsRequest({ kind: 'read' })).rejects.toThrow('Helia 앱');
	expect(host).not.toHaveBeenCalled();
});

it('rejects desktop previews and unavailable bridges without falling back to HTTP', async () => {
	flags.desktop = true;
	const fetch = vi.fn();
	vi.stubGlobal('fetch', fetch);
	await expect(aiSettingsRequest({ kind: 'read' })).rejects.toThrow('Helia 앱');
	flags.native = true;
	const main = {};
	Object.assign(main, { top: main });
	vi.stubGlobal('window', main);
	await expect(aiSettingsRequest({ kind: 'read' })).rejects.toThrow('접근할 수 없어요');
	expect(fetch).not.toHaveBeenCalled();
});
