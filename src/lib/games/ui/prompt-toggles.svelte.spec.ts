import '../../../app.css';
import { beforeEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import {
	savePromptSettings,
	loadSelectedPromptConfig
} from '#lib/app/settings/prompt-repository.js';
import { PromptSelection } from '#lib/app/settings/prompt-selection.svelte.js';
import {
	emptyPromptSettings,
	upsertPromptPreset,
	selectPromptPreset
} from '#lib/app/settings/prompts.js';
import { parsePromptConfig } from '#lib/games/ai/prompts.js';

import PromptToggles from './PromptToggles.svelte';

beforeEach(() => localStorage.clear());

function settings() {
	const initial = emptyPromptSettings();
	initial.presets[0].config = parsePromptConfig({
		toggles:
			'=묘사=group\ndetail=자세히\nstyle=문체=select=간결,서정\nnote=추가 지시=text\ncontext=배경 지시=textarea\n=설명입니다=caption\n=고급=divider\n==groupEnd'
	});
	return initial;
}

it('renders preset controls and persists each change immediately across remounts and preset switches', async () => {
	savePromptSettings(settings());
	const selection = new PromptSelection();
	const dispose = selection.mount();
	const screen = render(PromptToggles, { selection });
	await expect.element(page.getByText('설명입니다')).toBeVisible();
	await page.getByRole('switch', { name: '자세히' }).click();
	await page.getByRole('combobox', { name: '문체' }).selectOptions('1');
	await page.getByRole('textbox', { name: '추가 지시' }).fill('한글 {{user}}');
	await page.getByRole('textbox', { name: '배경 지시' }).fill('첫 줄\n둘째 줄');
	const captured = loadSelectedPromptConfig();
	expect(captured.toggleValues).toEqual({
		detail: '1',
		style: '1',
		note: '한글 {{user}}',
		context: '첫 줄\n둘째 줄'
	});
	const stored = JSON.parse(localStorage.getItem('helia:prompt-settings')!);
	const other = upsertPromptPreset(stored, {
		id: 'other',
		name: '다른 프리셋',
		config: parsePromptConfig({ toggles: 'detail=다른 묘사' })
	});
	savePromptSettings(selectPromptPreset(other, 'other'));
	await expect.element(page.getByRole('switch', { name: '다른 묘사' })).not.toBeChecked();
	expect(captured.toggleValues.detail).toBe('1');
	savePromptSettings(selectPromptPreset(other, 'default'));
	await expect.element(page.getByRole('switch', { name: '자세히' })).toBeChecked();
	await screen.unmount();
	dispose();
	const restored = new PromptSelection();
	restored.load();
	render(PromptToggles, { selection: restored });
	await expect
		.element(page.getByRole('textbox', { name: '추가 지시' }))
		.toHaveValue('한글 {{user}}');
	await expect.element(page.getByRole('combobox', { name: '문체' })).toHaveValue('1');
});

it('reports failed saves without changing persisted settings and disables controls while blocked', async () => {
	savePromptSettings(settings());
	const selection = new PromptSelection();
	selection.load();
	const screen = render(PromptToggles, { selection, blocked: true });
	await expect.element(page.getByRole('switch', { name: '자세히' })).toBeDisabled();
	await screen.rerender({ blocked: false });
	const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
		throw Error('quota');
	});
	try {
		await page.getByRole('switch', { name: '자세히' }).click();
		await expect.element(page.getByRole('alert')).toHaveTextContent('저장하지 못했어요');
		expect(loadSelectedPromptConfig().toggleValues.detail).toBe('0');
	} finally {
		write.mockRestore();
	}
	await page.getByRole('button', { name: '다시 불러오기' }).click();
	await expect.element(page.getByRole('switch', { name: '자세히' })).not.toBeChecked();
});
