import '../../../app.css';
import { expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { commands, page } from 'vitest/browser';

import type {} from '#lib/testing/message-frame-command.js';

import { emptyAISettings } from '#lib/app/settings/model.js';

import { createRegexRule } from '../regex.js';
import { createGame, getSessionConversation, updateGameSettings } from '../repository.js';
import SessionChat from './SessionChat.svelte';

vi.mock('#lib/app/settings/repository.js', () => ({ loadAISettings: () => emptyAISettings() }));
vi.mock('#lib/storage/transport.js', async () => {
	const { memoryStorage } = await import('#lib/testing/memory-storage.js');
	return { storageRequest: memoryStorage() };
});

it('transforms opening messages before HTML detection and preserves the original across rule changes', async () => {
	const game = await createGame();
	await updateGameSettings(game.id, {
		title: game.title,
		description: '',
		authorNote: '',
		firstMessage: '[손님: 엘렌]'
	});
	const rule = {
		...createRegexRule(),
		pattern: '\\[손님: (.*?)\\]',
		replacement: '<strong>$1</strong><script>window.parent.hacked=true</script>'
	};
	const screen = render(SessionChat, {
		gameId: game.id,
		sessionId: game.activeSessionId,
		gameTitle: game.title,
		regex: [rule],
		onsessionupdate: vi.fn(),
		onsavingchange: vi.fn()
	});
	await expect.poll(async () => (await commands.inspectMessageFrame()).text).toBe('엘렌');
	const frame = await commands.inspectMessageFrame();
	expect(frame.isolated).toBe(true);
	expect(frame.html).not.toContain('<script');
	expect((await getSessionConversation(game.id, game.activeSessionId)).messages[0].content).toBe(
		'[손님: 엘렌]'
	);
	await screen.rerender({ regex: [{ ...rule, replacement: '**$1**' }] });
	await expect
		.poll(async () => (await commands.inspectMessageFrame()).html)
		.toContain('<strong>엘렌</strong>');
	await screen.rerender({ regex: [] });
	await expect.element(page.getByText('[손님: 엘렌]', { exact: true })).toBeVisible();
	await expect.element(page.getByTitle('메시지 HTML')).not.toBeInTheDocument();
});
