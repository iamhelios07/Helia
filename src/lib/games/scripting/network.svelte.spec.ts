import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';

import { networkHop } from '#lib/games/network/transport.js';
import {
	createGame,
	updateGameRules,
	getSessionHistory,
	executeSessionAction,
	getSessionTimeline
} from '#lib/games/repository.js';

vi.mock('#lib/storage/transport.js', async () => {
	const { memoryStorage } = await import('#lib/testing/memory-storage.js');
	return { storageRequest: memoryStorage() };
});
vi.mock('#lib/games/network/transport.js', () => ({ networkHop: vi.fn() }));
beforeEach(() => {
	vi.mocked(networkHop).mockReset();
});
const aborts: AbortController[] = [];
afterEach(() => {
	for (const abort of aborts.splice(0)) {
		abort.abort();
	}
});
async function game(body: string, extra = '') {
	const game = await createGame();
	await updateGameRules(game.id, {
		schema: {
			type: 'object',
			properties: { gold: { type: 'integer' } },
			additionalProperties: false
		},
		initialState: { gold: 100 },
		scripts: {
			main: {
				language: 'typescript',
				source: `helia.defineAction({name:'remote',async run({state}){${body}}});${extra}`
			}
		}
	});
	await getSessionHistory(game.id, game.activeSessionId);
	return game;
}
function execute(game: { id: string; activeSessionId: string }) {
	const abort = new AbortController();
	aborts.push(abort);
	const promise = executeSessionAction(
		game.id,
		game.activeSessionId,
		{ expectedRevision: 0, action: { name: 'remote', args: {} } },
		{ signal: abort.signal }
	);
	return { promise, abort };
}
it('runs fetch inside an Action through the actual Worker and commits only after the response is validated', async () => {
	let finish!: (response: Response) => void;
	vi.mocked(networkHop).mockImplementation(
		async () =>
			new Promise<Response>((resolve) => {
				finish = resolve;
			})
	);
	const current = await game(
		`state.gold=0;helia.appendMessage({role:'assistant',content:'remote result'});const response=await helia.fetch(new Request('https://logic.example/gold',{headers:{authorization:'Bearer supplied'}}));state.gold=(await response.json()).gold;return state;`
	);
	const { promise } = execute(current);
	const dialog = page.getByRole('dialog', { name: '외부 연결 허용' });
	await expect.element(dialog).toHaveTextContent('이번 작업이 끝날 때까지');
	await expect
		.element(dialog)
		.toHaveTextContent(
			"'다시 묻지 않기'를 선택하면 설정의 '외부 연결'에서 취소할 때까지 이 게임에서는 이 주소를 다시 묻지 않습니다."
		);
	expect(networkHop).not.toHaveBeenCalled();
	await dialog.getByRole('button', { name: '허용', exact: true }).click();
	await expect.poll(() => networkHop).toHaveBeenCalledOnce();
	expect((await getSessionHistory(current.id, current.activeSessionId)).progress.state).toEqual({
		gold: 100
	});
	expect((await getSessionTimeline(current.id, current.activeSessionId)).events).toHaveLength(0);
	finish(Response.json({ gold: 75 }));
	const saved = await promise;
	expect(saved.progress.state).toEqual({ gold: 75 });
	expect(saved.transactions).toHaveLength(1);
	expect(
		(await getSessionTimeline(current.id, current.activeSessionId)).messages.at(-1)?.content
	).toBe('remote result');
	expect(vi.mocked(networkHop).mock.calls[0][0].headers).toContainEqual([
		'authorization',
		'Bearer supplied'
	]);
}, 25000);
it('discards state and messages when consent is denied', async () => {
	const current = await game(
		`state.gold=0;helia.appendMessage({role:'assistant',content:'must be discarded'});await fetch('https://denied-logic.example/');return state;`
	);
	const result = execute(current);
	const rejected = expect(result.promise).rejects.toMatchObject({ code: 'execution' });
	await page
		.getByRole('dialog', { name: '외부 연결 허용' })
		.getByRole('button', { name: '취소', exact: true })
		.click();
	await rejected;
	expect(networkHop).not.toHaveBeenCalled();
	const saved = await getSessionTimeline(current.id, current.activeSessionId);
	expect(saved.history.progress.state).toEqual({ gold: 100 });
	expect(saved.events).toHaveLength(0);
	expect(saved.messages).toHaveLength(0);
}, 25000);
it('cancels pending consent with the Action and does not save a partial state', async () => {
	const current = await game(
		`state.gold=0;await fetch('https://cancel-logic.example/');return state;`
	);
	const { promise, abort } = execute(current);
	const rejected = expect(promise).rejects.toMatchObject({ code: 'canceled' });
	const dialog = page.getByRole('dialog', { name: '외부 연결 허용' });
	await expect.element(dialog).toBeVisible();
	abort.abort();
	await rejected;
	await expect.element(dialog).not.toBeInTheDocument();
	expect((await getSessionHistory(current.id, current.activeSessionId)).progress.state).toEqual({
		gold: 100
	});
	expect(networkHop).not.toHaveBeenCalled();
}, 25000);
it('cancels an active request and rejects a stale result after another session write', async () => {
	let finish!: (response: Response) => void;
	let requestSignal: AbortSignal | undefined;
	vi.mocked(networkHop).mockImplementation(async (_input, signal) => {
		requestSignal = signal;
		return new Promise<Response>((resolve) => {
			finish = resolve;
		});
	});
	const current = await game(
		`state.gold=(await (await fetch('https://conflict-logic.example/')).json()).gold;return state;`,
		`helia.defineAction({name:'local',run({state}){state.gold=90;return state;}});`
	);
	const { promise } = execute(current);
	const rejected = expect(promise).rejects.toMatchObject({ code: 'conflict' });
	await page
		.getByRole('dialog', { name: '외부 연결 허용' })
		.getByRole('button', { name: '허용', exact: true })
		.click();
	await expect.poll(() => networkHop).toHaveBeenCalledOnce();
	await executeSessionAction(current.id, current.activeSessionId, {
		expectedRevision: 0,
		action: { name: 'local', args: {} }
	});
	finish(Response.json({ gold: 1 }));
	await rejected;
	expect((await getSessionHistory(current.id, current.activeSessionId)).progress.state).toEqual({
		gold: 90
	});
	await expect.poll(() => requestSignal?.aborted).toBe(true);
}, 30000);
