import '../../../app.css';
import { beforeEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import { saveAISettings } from '#lib/app/settings/repository.js';

import AppFixture from '../../testing/AppFixture.svelte';
import {
	createGame,
	createSession,
	updateGameRules,
	updateGameSettings,
	getSessionHistory,
	commitSessionTransaction,
	selectSessionBranch,
	deleteSessionResponse,
	saveSessionMemory,
	listSessionMemories
} from '../repository.js';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('../ai/browser.js', () => ({
	invokeSessionAI: async (gameId: string, sessionId: string, input: { text: string }) => {
		const { appendUserMessage, getSessionTimeline } = await import('../repository.js');
		await appendUserMessage(gameId, sessionId, input.text);
		return getSessionTimeline(gameId, sessionId);
	}
}));
vi.mock('../../storage/transport.js', async () => {
	const { memoryStorage } = await import('../../testing/memory-storage.js');
	return { storageRequest: memoryStorage() };
});

beforeEach(async () => {
	localStorage.clear();
	saveAISettings({
		version: 1,
		providers: [
			{ id: 'provider', name: 'API', kind: 'openai-compatible', baseUrl: 'https://example.com/v1' }
		],
		models: [{ id: 'model', name: 'Test model', providerId: 'provider', modelId: 'test' }],
		defaultModelId: 'model'
	});
	await page.viewport(1280, 900);
});

it('keeps real chat, state and memories on the selected response branch across remounts', async () => {
	const game = await createForge();
	const gameId = game.id;
	const sessionId = game.activeSessionId;
	let screen = render(AppFixture, { view: 'game', gameId });
	await expect.element(page.getByRole('article', { name: '게임 메시지' })).toBeVisible();
	await page.getByRole('textbox', { name: '메시지', exact: true }).fill('철을 구매한다.');
	await page.getByRole('button', { name: '메시지 전송' }).click();
	await expect.element(page.getByRole('article', { name: '플레이어 메시지' })).toBeVisible();
	const { purchaseId, responseId } = await rememberedPurchaseResponse(gameId, sessionId);
	await screen.unmount();
	screen = render(AppFixture, { view: 'game', gameId });
	await expect
		.poll(messages)
		.toEqual(['대장간의 문을 열었다.', '철을 구매한다.', '상인이 반갑게 철을 건넸다.']);
	await page.getByRole('textbox', { name: '메시지', exact: true }).fill('추가 작업을 시작한다.');
	await page.getByRole('button', { name: '메시지 전송' }).click();
	await expect.poll(messages).toHaveLength(4);
	let history = await getSessionHistory(gameId, sessionId);
	history = await commitSessionTransaction(gameId, sessionId, {
		expectedRevision: history.progress.revision,
		parentId: history.progress.headId,
		nextState: { gold: 70, iron: 5, reputation: 1 },
		action: { name: '작업 비용', args: {} }
	});
	const oldHead = history.progress.headId;
	history = await commitSessionTransaction(gameId, sessionId, {
		expectedRevision: history.progress.revision,
		parentId: purchaseId,
		nextState: { gold: 80, iron: 5, reputation: -1 },
		action: { name: '응답 B', args: {} },
		message: { role: 'assistant', content: '상인이 퉁명스럽게 철을 내려놓았다.' }
	});
	expect(history.progress.state).toEqual({ gold: 80, iron: 5, reputation: -1 });
	expect(await listSessionMemories(gameId, sessionId)).toEqual([]);
	await screen.unmount();
	screen = render(AppFixture, { view: 'game', gameId });
	await expect
		.poll(messages)
		.toEqual(['대장간의 문을 열었다.', '철을 구매한다.', '상인이 퉁명스럽게 철을 내려놓았다.']);
	history = await selectSessionBranch(gameId, sessionId, oldHead, history.progress.revision);
	expect(history.progress.state).toEqual({ gold: 70, iron: 5, reputation: 1 });
	expect(await listSessionMemories(gameId, sessionId)).toHaveLength(1);
	await screen.unmount();
	screen = render(AppFixture, { view: 'game', gameId });
	await expect
		.poll(messages)
		.toEqual([
			'대장간의 문을 열었다.',
			'철을 구매한다.',
			'상인이 반갑게 철을 건넸다.',
			'추가 작업을 시작한다.'
		]);
	history = await deleteSessionResponse(gameId, sessionId, responseId, history.progress.revision);
	expect(history.progress.state).toEqual({ gold: 80, iron: 5 });
	expect(history.transactions).toHaveLength(3);
	await screen.unmount();
	screen = render(AppFixture, { view: 'game', gameId });
	await expect.poll(messages).toEqual(['대장간의 문을 열었다.', '철을 구매한다.']);
	const next = await createSession(gameId);
	expect((await getSessionHistory(gameId, next.id)).progress.state).toEqual({ gold: 100, iron: 3 });
	expect((await getSessionHistory(gameId, sessionId)).progress.state).toEqual({
		gold: 80,
		iron: 5
	});
	await screen.unmount();
});

async function createForge() {
	const game = await createGame();
	const gameId = game.id;
	await updateGameRules(gameId, {
		schema: {
			type: 'object',
			properties: {
				gold: { type: 'integer' },
				iron: { type: 'integer' },
				reputation: { type: 'integer' }
			},
			additionalProperties: false
		},
		initialState: { gold: 100, iron: 3 },
		scripts: {}
	});
	await updateGameSettings(gameId, {
		title: '대장간',
		description: '',
		firstMessage: '대장간의 문을 열었다.',
		authorNote: ''
	});

	return game;
}
function messages() {
	return Array.from(
		page.getByRole('log').element().querySelectorAll('.message-content'),
		(element) => element.textContent
	);
}

async function rememberedPurchaseResponse(gameId: string, sessionId: string) {
	let history = await getSessionHistory(gameId, sessionId);
	expect(history.transactions[0].action.name).toBe('sendMessage');
	history = await commitSessionTransaction(gameId, sessionId, {
		expectedRevision: history.progress.revision,
		parentId: history.progress.headId,
		nextState: { gold: 80, iron: 5 },
		action: { name: '철 구매', args: {} }
	});
	const purchaseId = history.progress.headId;
	history = await commitSessionTransaction(gameId, sessionId, {
		expectedRevision: history.progress.revision,
		parentId: purchaseId,
		nextState: { gold: 80, iron: 5, reputation: 1 },
		action: { name: '응답 A', args: {} },
		message: { role: 'assistant', content: '상인이 반갑게 철을 건넸다.' }
	});
	const responseId = history.progress.headId!;
	await saveSessionMemory(gameId, sessionId, history.progress.revision, {
		sourceTransactionIds: [responseId],
		content: '상인이 반갑게 맞이했다.'
	});

	return { purchaseId, responseId };
}
