import { afterEach, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ desktop: false, tauri: false }));

vi.mock('#lib/platform/index.js', () => ({
	get isDesktopBuild() {
		return platform.desktop;
	},
	isTauri: () => platform.tauri
}));

vi.mock('@tauri-apps/api/core', () => ({
	convertFileSrc: (path: string, protocol: string) => `http://${protocol}.localhost/${path}`
}));

import { assetURL, desktopMediaBase } from './runtime-content.js';

const hash = 'a'.repeat(64);
const token = 'b'.repeat(64);
const validBase = `http://127.0.0.1:43210/${token}`;

afterEach(() => {
	platform.desktop = false;
	platform.tauri = false;
	vi.unstubAllGlobals();
});

it('builds desktop loopback media URLs when the main frame exposes a valid base', () => {
	platform.desktop = true;
	const view: Record<string, unknown> = { __HELIA_MEDIA_BASE__: validBase };
	view.top = view;
	vi.stubGlobal('window', view);

	expect(desktopMediaBase()).toBe(validBase);
	expect(assetURL('game-1', `helia-asset:${hash}`)).toBe(`${validBase}/game-1/${hash}`);
	// v1 data URIs keep passing through untouched.
	const dataUri = 'data:image/png;base64,AA==';
	expect(assetURL('game-1', dataUri)).toBe(dataUri);
});

it('rejects subframe and malformed loopback bases and falls back to the custom scheme', () => {
	platform.desktop = true;
	// Subframe must never read __HELIA_MEDIA_BASE__.
	vi.stubGlobal('window', { top: {}, __HELIA_MEDIA_BASE__: validBase });
	expect(desktopMediaBase()).toBeNull();
	expect(assetURL('game-1', `helia-asset:${hash}`)).toBe(
		`http://helia-media.localhost/game-1/${hash}`
	);

	for (const bad of [
		`https://127.0.0.1:43210/${token}`,
		`http://localhost:43210/${token}`,
		`http://127.0.0.1:0/${token}`,
		`http://127.0.0.1:70000/${token}`,
		'http://127.0.0.1:43210/short',
		`http://127.0.0.1:43210/${token}/extra`,
		`http://127.0.0.1:43210/${token};script-src`
	]) {
		const view: Record<string, unknown> = { __HELIA_MEDIA_BASE__: bad };
		view.top = view;
		vi.stubGlobal('window', view);
		expect(desktopMediaBase(), bad).toBeNull();
	}
});

it('keeps web asset URLs and v1 data URIs unchanged outside desktop builds', () => {
	platform.desktop = false;
	vi.stubGlobal('location', { origin: 'https://helia.example' });
	expect(assetURL('game-1', `helia-asset:${hash}`)).toBe(
		`https://helia.example/api/games/game-1/assets/${hash}`
	);
	expect(assetURL('game-1', 'data:image/png;base64,AA==')).toBe('data:image/png;base64,AA==');
});
