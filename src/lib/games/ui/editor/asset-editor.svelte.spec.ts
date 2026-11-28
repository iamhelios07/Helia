import '../../../../app.css';
import { expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';

import { isDesktopBuild } from '#lib/platform/index.js';

import AssetEditor from './AssetEditor.svelte';

const reference = 'helia-asset:' + 'a'.repeat(64);
const source = JSON.stringify({
	portrait: { name: 'portrait.png', mime: 'image/png', data: reference }
});

it('opens uploaded references with accessible metadata and host previews without hydration', async () => {
	const onchange = vi.fn();
	const screen = render(AssetEditor, { source, selectedId: 'portrait', gameId: 'game', onchange });
	await expect.element(page.getByText('image/png · 업로드된 파일')).toBeVisible();
	await userEvent.keyboard('{Tab}');
	await expect.element(page.getByRole('textbox', { name: '에셋 파일 경로' })).toHaveFocus();
	await expect
		.element(page.getByRole('textbox', { name: '에셋 파일 경로' }))
		.toHaveAccessibleDescription('image/png · 업로드된 파일');
	if (isDesktopBuild) {
		await expect.element(page.getByRole('img')).not.toBeInTheDocument();
	} else {
		await expect
			.element(page.getByRole('img', { name: 'portrait.png' }))
			.toHaveAttribute('src', `${location.origin}/api/games/game/assets/${'a'.repeat(64)}`);
	}
	await screen.rerender({ selectedId: 'missing' });
	await screen.rerender({ selectedId: 'portrait' });
	await expect
		.element(page.getByRole('textbox', { name: '에셋 코드 참조' }))
		.toHaveValue('helia.asset("portrait.png")');
	expect(onchange).not.toHaveBeenCalled();
});

it('shows uploaded metadata without a game scope instead of using an asset reference as a URL', async () => {
	render(AssetEditor, { source, selectedId: 'portrait', onchange: vi.fn() });
	await expect.element(page.getByText('image/png · 업로드된 파일')).toBeVisible();
	await expect.element(page.getByRole('img')).not.toBeInTheDocument();
});
