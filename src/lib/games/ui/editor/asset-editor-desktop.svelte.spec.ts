import '../../../../app.css';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

const media = vi.hoisted(() => ({ base: null as string | null }));

vi.mock('#lib/platform/index.js', () => ({
	isDesktopBuild: true,
	isTauri: () => true
}));

vi.mock('../../runtime-content.js', () => ({
	desktopMediaBase: () => media.base,
	assetURL: (gameId: string, reference: string) =>
		media.base && /^helia-asset:[a-f0-9]{64}$/.test(reference)
			? `${media.base}/${encodeURIComponent(gameId)}/${reference.slice(12)}`
			: reference
}));

import AssetEditor from './AssetEditor.svelte';

const hash = 'a'.repeat(64);
const base = `http://127.0.0.1:45678/${'b'.repeat(64)}`;
const source = JSON.stringify({
	portrait: { name: 'portrait.png', mime: 'image/png', data: 'helia-asset:' + hash }
});

afterEach(() => {
	media.base = null;
});

it('previews uploaded references on desktop through the loopback media server URL', async () => {
	media.base = base;
	render(AssetEditor, { source, selectedId: 'portrait', gameId: 'game', onchange: vi.fn() });
	await expect
		.element(page.getByRole('img', { name: 'portrait.png' }))
		.toHaveAttribute('src', `${base}/game/${hash}`);
});

it('falls back to uploaded label on desktop when no loopback media base is injected', async () => {
	media.base = null;
	render(AssetEditor, { source, selectedId: 'portrait', gameId: 'game', onchange: vi.fn() });
	await expect.element(page.getByText('업로드된 파일', { exact: true })).toBeVisible();
	await expect.element(page.getByRole('img')).not.toBeInTheDocument();
});
