import '../../../app.css';
import { goto } from '$app/navigation';
import { tick } from 'svelte';
import { beforeEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import { emptyAISettings } from '#lib/app/settings/model.js';
import { savePromptSettings } from '#lib/app/settings/prompt-repository.js';
import { emptyPromptSettings } from '#lib/app/settings/prompts.js';
import { parsePromptConfig } from '#lib/games/ai/prompts.js';
import HistoryWorkspaceFixture from '#lib/testing/HistoryWorkspaceFixture.svelte';

import { createGame, getGameWorkspace } from '../repository.js';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('#lib/app/settings/repository.js', () => ({ loadAISettings: () => emptyAISettings() }));
vi.mock('#lib/storage/transport.js', async () => {
	const { memoryStorage } = await import('#lib/testing/memory-storage.js');
	return { storageRequest: memoryStorage() };
});

beforeEach(() => {
	localStorage.clear();
	vi.mocked(goto).mockReset();
});

async function fixture() {
	const settings = emptyPromptSettings();
	settings.presets[0].config = parsePromptConfig({
		toggles: [
			'=긴 토글 그룹=group',
			...Array.from({ length: 100 }, (_, index) => `option${index}=설정 ${index}`),
			'==groupEnd'
		].join('\n')
	});
	savePromptSettings(settings);
	const game = await createGame();
	const workspace = (await getGameWorkspace(game.id))!;
	render(HistoryWorkspaceFixture, {
		game: workspace.game,
		session: workspace.sessions[0],
		onsessionupdate: vi.fn(),
		onsavingchange: vi.fn()
	});
	await expect.element(page.getByText('긴 토글 그룹', { exact: true })).toBeVisible();
	const group = page.getByText('긴 토글 그룹', { exact: true }).element().closest('details')!;
	group.open = false;
	await tick();
	await page.getByRole('tab', { name: '게임', exact: true }).click();
	const sidebar = page.getByRole('complementary', { name: '게임 세션' }).element();
	return {
		game,
		group,
		sidebar,
		scroll: page
			.getByRole('region', { name: '사이드바 스크롤', exact: true })
			.element() as HTMLDivElement
	};
}

it.each([
	{ width: 1280, height: 720 },
	{ width: 390, height: 844 }
])(
	'keeps game settings and editor reachable when long toggles expand at $width px',
	async (viewport) => {
		await page.viewport(viewport.width, viewport.height);
		const { game, group, sidebar, scroll } = await fixture();
		const editor = page.getByRole('link', { name: '게임 편집기 열기', exact: true });
		const width = scroll.clientWidth;
		group.open = true;
		await tick();
		scroll.scrollTop = 0;
		expect(scroll.clientWidth).toBe(width);
		expect(scroll.offsetWidth - scroll.clientWidth).toBe(0);
		const panel = page.getByRole('tabpanel', { name: '게임', exact: true }).element();
		const editorRect = editor.element().getBoundingClientRect();
		const panelRect = panel.getBoundingClientRect();
		expect(
			panelRect.height,
			'expanding toggle content must not collapse the game settings panel'
		).toBeGreaterThanOrEqual(editorRect.height);
		expect(editorRect.top).toBeGreaterThanOrEqual(scroll.getBoundingClientRect().top);
		expect(editorRect.bottom).toBeLessThanOrEqual(
			Math.min(panelRect.bottom, sidebar.getBoundingClientRect().bottom)
		);
		expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
		const description = page
			.getByRole('textbox', { name: '설명', exact: true })
			.element() as HTMLTextAreaElement;
		description.style.height = '500px';
		page
			.getByRole('region', { name: '게임 설정 스크롤', exact: true })
			.element()
			.focus({ preventScroll: true });
		const inner = page.getByRole('scrollbar', { name: '게임 설정 스크롤 이동', exact: true });
		await expect.element(inner).toBeVisible();
		const thumb = inner.element().firstElementChild!;
		const thumbRect = thumb.getBoundingClientRect();
		expect(
			document.elementFromPoint(
				thumbRect.left + thumbRect.width / 2,
				thumbRect.top + thumbRect.height / 2
			),
			'the outer overlay must not intercept the inner thumb'
		).toBe(thumb);
		scroll.scrollTop = scroll.scrollHeight;
		const last = page
			.getByRole('switch', { name: '설정 99', exact: true })
			.element()
			.getBoundingClientRect();
		expect(last.bottom).toBeLessThanOrEqual(sidebar.getBoundingClientRect().bottom);
		scroll.scrollTop = 0;
		await editor.click();
		await expect.poll(() => vi.mocked(goto).mock.calls.at(-1)?.[0]).toBe(`/games/${game.id}/edit`);
	}
);
