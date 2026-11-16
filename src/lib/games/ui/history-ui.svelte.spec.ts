import '../../../app.css';
import { beforeEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { commands, page, userEvent } from 'vitest/browser';

import type {} from '#lib/testing/message-frame-command.js';

import { saveAISettings } from '#lib/app/settings/repository.js';
import { aiSettingsRequest } from '#lib/app/settings/settings-transport.js';
import { memoryAISettingsTransport } from '#lib/testing/ai-settings.js';

import type { Game } from '../model.js';

import {
	createGame,
	updateGameRules,
	updateGameSettings,
	getSessionHistory,
	commitSessionTransaction,
	saveSessionMemory,
	getSessionTimeline,
	executeSessionAction
} from '../repository.js';
import SessionChat from './SessionChat.svelte';

vi.mock('#lib/app/settings/settings-transport.js', () => ({ aiSettingsRequest: vi.fn() }));
vi.mock('../../storage/transport.js', async () => {
	const { memoryStorage } = await import('../../testing/memory-storage.js');
	return { storageRequest: memoryStorage() };
});
vi.mock('../ai/browser.js', () => ({
	invokeSessionAI: async (gameId: string, sessionId: string, input: { text: string }) => {
		const { appendUserMessage, getSessionTimeline } = await import('../repository.js');
		await appendUserMessage(gameId, sessionId, input.text);
		return getSessionTimeline(gameId, sessionId);
	}
}));

beforeEach(async () => {
	vi.mocked(aiSettingsRequest).mockReset().mockImplementation(memoryAISettingsTransport());
	await saveAISettings({
		version: 1,
		providers: [
			{ id: 'provider', name: 'API', kind: 'openai-compatible', baseUrl: 'https://example.com/v1' }
		],
		models: [{ id: 'model', name: 'Test model', providerId: 'provider', modelId: 'test' }],
		defaultModelId: 'model'
	});
	await page.viewport(1280, 900);
});

async function fixture(scripts: Game['scripts'] = {}) {
	const game = await createGame();
	const gameId = game.id;
	const sessionId = game.activeSessionId;
	await updateGameRules(gameId, {
		schema: {
			type: 'object',
			properties: { gold: { type: 'integer' } },
			required: ['gold'],
			additionalProperties: false
		},
		initialState: { gold: 100 },
		scripts
	});
	await updateGameSettings(gameId, {
		title: '상점',
		description: '',
		firstMessage: '상점에 도착했다.',
		authorNote: ''
	});
	let history = await getSessionHistory(gameId, sessionId);
	const commit = async (name: string, parentId: string | null, gold: number) => {
		history = await commitSessionTransaction(gameId, sessionId, {
			expectedRevision: history.progress.revision,
			parentId,
			nextState: { gold },
			description: name,
			action: { name, args: {} },
			message: { role: 'assistant', content: `${name} 완료` }
		});
		return history.progress.headId!;
	};
	const shared = await commit('입장', null, 100);
	const purchase = await commit('구매', shared, 80);
	const tail = await commit('추가 구매', purchase, 70);
	await saveSessionMemory(gameId, sessionId, history.progress.revision, {
		sourceTransactionIds: [purchase, tail],
		content: '물건 두 개를 샀다.'
	});
	const other = await commit('돌아가기', shared, 100);
	const onsessionupdate = vi.fn();
	const onsavingchange = vi.fn();
	const mount = () =>
		render(SessionChat, { gameId, sessionId, gameTitle: '상점', onsessionupdate, onsavingchange });
	return {
		gameId,
		sessionId,
		shared,
		purchase,
		tail,
		other,
		mount,
		onsessionupdate,
		onsavingchange
	};
}

function conversation() {
	return Array.from(
		page.getByRole('log').element().querySelectorAll('.message-content'),
		(node) => node.textContent
	);
}

it('displays every message belonging to one Action in chat and in its history details', async () => {
	const setup = await fixture({
		main: {
			language: 'typescript',
			source: `
helia.defineAction({name:'order',run({state}){
  helia.appendMessage({role:'user',content:'검을 주문한다.'});
  helia.appendMessage({role:'assistant',content:'주문을 접수했다.'});
  return state;
}});`
		}
	});
	const screen = setup.mount();
	await expect.poll(conversation).toHaveLength(3);
	const before = await getSessionHistory(setup.gameId, setup.sessionId);
	await executeSessionAction(setup.gameId, setup.sessionId, {
		expectedRevision: before.progress.revision,
		action: { name: 'order', args: {} }
	});
	await expect
		.poll(conversation)
		.toEqual([
			'상점에 도착했다.',
			'입장 완료',
			'돌아가기 완료',
			'검을 주문한다.',
			'주문을 접수했다.'
		]);
	await page.getByRole('button', { name: '이력과 분기', exact: true }).click();
	const events = page
		.getByRole('region', { name: '세션 이력' })
		.element()
		.querySelectorAll('.event');
	const last = events[events.length - 1];
	const details = last.querySelector('details')!;
	details.open = true;
	expect(Array.from(details.querySelectorAll('.dialogue'), (node) => node.textContent)).toEqual([
		'검을 주문한다.',
		'주문을 접수했다.'
	]);
	await screen.unmount();
});

it('renders HTML from committed actions and stays at the end as message height arrives', async () => {
	const setup = await fixture();
	const screen = setup.mount();
	screen.container.style.height = '300px';
	screen.container.style.display = 'flex';
	await expect.poll(conversation).toHaveLength(3);
	const history = await getSessionHistory(setup.gameId, setup.sessionId);
	await commitSessionTransaction(setup.gameId, setup.sessionId, {
		expectedRevision: history.progress.revision,
		parentId: history.progress.headId,
		nextState: history.progress.state,
		action: { name: '주문서 표시', args: {} },
		message: {
			role: 'assistant',
			content: '<div style="height:600px"><strong>새 주문서</strong></div>'
		}
	});
	await expect.poll(async () => (await commands.inspectMessageFrame()).text).toBe('새 주문서');
	const viewport = screen.container.querySelector<HTMLElement>('.history')!;
	await expect
		.poll(() => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop)
		.toBeLessThan(2);
	await screen.unmount();
});

it('refreshes external commits without remounting or losing the draft and open timeline', async () => {
	const setup = await fixture();
	const screen = setup.mount();
	await expect.poll(conversation).toEqual(['상점에 도착했다.', '입장 완료', '돌아가기 완료']);
	await page.getByRole('textbox', { name: '메시지', exact: true }).fill('유지할 초안');
	await page.getByRole('button', { name: '이력과 분기', exact: true }).click();
	const history = await getSessionHistory(setup.gameId, setup.sessionId);
	await commitSessionTransaction(setup.gameId, setup.sessionId, {
		expectedRevision: history.progress.revision,
		parentId: history.progress.headId,
		nextState: { gold: 95 },
		action: { name: '패널 행동', args: {} },
		message: { role: 'assistant', content: '패널에서 구매했다.' }
	});
	await expect
		.poll(conversation)
		.toEqual(['상점에 도착했다.', '입장 완료', '돌아가기 완료', '패널에서 구매했다.']);
	await expect
		.element(page.getByRole('textbox', { name: '메시지', exact: true }))
		.toHaveValue('유지할 초안');
	await expect.element(page.getByRole('region', { name: '세션 이력' })).toBeVisible();
	await screen.unmount();
});

it('preserves chat scroll when an external action only changes state', async () => {
	const setup = await fixture();
	const screen = setup.mount();
	screen.container.style.height = '220px';
	screen.container.style.display = 'flex';
	await expect.poll(conversation).toHaveLength(3);
	const viewport = screen.container.querySelector<HTMLElement>('.history')!;
	await expect.poll(() => viewport.scrollTop).toBeGreaterThan(0);
	viewport.scrollTop = 25;
	const updates = setup.onsessionupdate.mock.calls.length;
	const history = await getSessionHistory(setup.gameId, setup.sessionId);
	await commitSessionTransaction(setup.gameId, setup.sessionId, {
		expectedRevision: history.progress.revision,
		parentId: history.progress.headId,
		nextState: { gold: 99 },
		action: { name: '상태 변경', args: {} }
	});
	await expect.poll(() => setup.onsessionupdate.mock.calls.length).toBeGreaterThan(updates);
	expect(viewport.scrollTop).toBe(25);
	await screen.unmount();
});

it('navigates entire atomic events, restores state and memories, keeps drafts and forks on send', async () => {
	const setup = await fixture();
	let screen = setup.mount();
	await expect.poll(conversation).toEqual(['상점에 도착했다.', '입장 완료', '돌아가기 완료']);
	await page.getByRole('textbox', { name: '메시지', exact: true }).fill('보존할 초안');
	await page.getByRole('button', { name: '이력과 분기', exact: true }).click();
	const panel = page.getByRole('region', { name: '세션 이력' });
	await expect
		.element(panel.getByRole('button', { name: '구매 다른 분기', exact: true }))
		.toBeVisible();
	await panel.getByRole('button', { name: '추가 구매 다른 분기', exact: true }).click();
	await expect
		.poll(conversation)
		.toEqual(['상점에 도착했다.', '입장 완료', '구매 완료', '추가 구매 완료']);
	await expect
		.element(page.getByRole('textbox', { name: '메시지', exact: true }))
		.toHaveValue('보존할 초안');
	await panel.getByText('현재 게임 상태', { exact: true }).click();
	await expect.element(panel.getByLabelText('현재 게임 상태')).toHaveTextContent('70');
	await panel.getByText('현재 경로의 기억 · 1개', { exact: true }).click();
	await expect
		.element(panel.getByRole('list', { name: '현재 경로의 기억' }))
		.toHaveTextContent('물건 두 개를 샀다.');
	await panel.getByRole('button', { name: '입장 현재 경로', exact: true }).click();
	await expect.poll(conversation).toEqual(['상점에 도착했다.', '입장 완료']);
	await page.getByRole('button', { name: '메시지 전송' }).click();
	await expect.poll(conversation).toEqual(['상점에 도착했다.', '입장 완료', '보존할 초안']);
	const timeline = await getSessionTimeline(setup.gameId, setup.sessionId);
	expect(timeline.events).toHaveLength(5);
	expect(timeline.events.find((event) => event.id === setup.tail)).toMatchObject({
		active: false,
		selected: false
	});
	expect(timeline.memories).toEqual([]);
	expect(setup.onsessionupdate).toHaveBeenCalled();
	expect(setup.onsavingchange).toHaveBeenCalledWith(false);
	await screen.unmount();
	screen = setup.mount();
	await expect.poll(conversation).toEqual(['상점에 도착했다.', '입장 완료', '보존할 초안']);
	await page.getByRole('button', { name: '이력과 분기', exact: true }).click();
	await panel.getByRole('button', { name: '초기 상태', exact: true }).click();
	await expect.poll(conversation).toEqual(['상점에 도착했다.']);
	await screen.unmount();
});

it('confirms subtree deletion, preserves sibling branches and removes attached messages and memories', async () => {
	const setup = await fixture();
	const screen = setup.mount();
	await expect.poll(conversation).toHaveLength(3);
	await page.getByRole('button', { name: '이력과 분기', exact: true }).click();
	const panel = page.getByRole('region', { name: '세션 이력' });
	await panel.getByRole('button', { name: '추가 구매 다른 분기', exact: true }).click();
	await expect.poll(conversation).toHaveLength(4);
	await panel.getByRole('button', { name: '구매 삭제', exact: true }).click();
	const modal = page.getByRole('dialog', { name: '이벤트 삭제' });
	await expect.element(modal).toBeVisible();
	await expect.element(modal).toHaveTextContent('모든 분기');
	await userEvent.keyboard('{Escape}');
	await expect.element(modal).not.toBeInTheDocument();
	expect((await getSessionTimeline(setup.gameId, setup.sessionId)).events).toHaveLength(4);
	await panel.getByRole('button', { name: '구매 삭제', exact: true }).click();
	await modal.getByRole('button', { name: '삭제', exact: true }).click();
	const afterRows = await getSessionTimeline(setup.gameId, setup.sessionId);
	console.log(
		'AFTER-DEL events=' +
			afterRows.events.length +
			' head=' +
			String(afterRows.history.progress.headId).slice(0, 8)
	);
	await expect.element(modal).not.toBeInTheDocument();
	await expect.poll(conversation).toEqual(['상점에 도착했다.', '입장 완료']);
	const timeline = await getSessionTimeline(setup.gameId, setup.sessionId);
	console.log('AFTER-DEL', JSON.stringify(timeline.events.map((e) => e.id.slice(0, 8))));
	expect(timeline.events.map((event) => event.id)).toEqual([setup.shared, setup.other]);
	expect(timeline.history.progress.headId).toBe(setup.shared);
	expect(timeline.memories).toEqual([]);
	await panel.getByRole('button', { name: '돌아가기 다른 분기', exact: true }).click();
	await expect.poll(conversation).toEqual(['상점에 도착했다.', '입장 완료', '돌아가기 완료']);
	await screen.unmount();
});

it('retains the timeline and deletion dialog on a revision conflict, then reloads and retries', async () => {
	const setup = await fixture();
	const screen = setup.mount();
	await expect.poll(conversation).toHaveLength(3);
	await page.getByRole('button', { name: '이력과 분기', exact: true }).click();
	const panel = page.getByRole('region', { name: '세션 이력' });
	await panel.getByRole('button', { name: '구매 삭제', exact: true }).click();
	const history = await getSessionHistory(setup.gameId, setup.sessionId);
	await commitSessionTransaction(setup.gameId, setup.sessionId, {
		expectedRevision: history.progress.revision,
		parentId: history.progress.headId,
		nextState: { gold: 99 },
		description: '외부 작업',
		action: { name: '외부 작업', args: {} }
	});
	const modal = page.getByRole('dialog', { name: '이벤트 삭제' });
	await modal.getByRole('button', { name: '삭제', exact: true }).click();
	await expect.element(modal.getByRole('alert')).toHaveTextContent('새로고침');
	expect((await getSessionTimeline(setup.gameId, setup.sessionId)).events).toHaveLength(5);
	await modal.getByRole('button', { name: '취소', exact: true }).click();
	await panel.getByRole('button', { name: '새로고침', exact: true }).click();
	await expect
		.element(panel.getByRole('button', { name: '외부 작업 현재 위치', exact: true }))
		.toBeVisible();
	await panel.getByRole('button', { name: '구매 삭제', exact: true }).click();
	await modal.getByRole('button', { name: '삭제', exact: true }).click();
	await expect.element(modal).not.toBeInTheDocument();
	expect((await getSessionTimeline(setup.gameId, setup.sessionId)).events).toHaveLength(3);
	await screen.unmount();
});
