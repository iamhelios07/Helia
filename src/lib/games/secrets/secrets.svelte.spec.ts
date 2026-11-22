import { afterEach, expect, it, vi } from 'vitest';

import {
	createGame,
	createSession,
	updateGameRules,
	getSessionHistory,
	getSessionTimeline
} from '#lib/games/repository.js';

import { mountGameUI } from '../ui/runtime/bridge.js';
import { gameSecrets } from './client.js';
import { secretOperation } from './protocol.js';
vi.mock('#lib/storage/transport.js', async () => {
	const { memoryStorage } = await import('#lib/testing/memory-storage.js');
	return { storageRequest: memoryStorage() };
});
vi.mock('#lib/games/network/permission.js', () => ({ requestNetworkPermission: async () => true }));
const disposers: (() => void)[] = [];
afterEach(() => {
	disposers.splice(0).forEach((dispose) => dispose());
	document.querySelectorAll('iframe').forEach((frame) => frame.remove());
	vi.unstubAllGlobals();
});
function mockSecretServer(token: string, ref: string) {
	const saved = new Map<string, string>(),
		scope = { gameId: '' };
	const send = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
		const url = String(input),
			body = JSON.parse(String(init?.body));
		if (url === '/api/network') {
			expect(body.gameId).toBe(scope.gameId);
			expect(body.headers).toContainEqual(['authorization', 'Bearer ' + ref]);
			expect(JSON.stringify(body)).not.toContain(token);
			return new Response(
				JSON.stringify({ kind: 'head', head: { status: 200, statusText: 'OK', headers: [] } }) +
					'\n' +
					JSON.stringify({ kind: 'end' }) +
					'\n'
			);
		}
		const gameId = url.split('/')[3],
			operation = secretOperation(body),
			key = gameId + ':' + operation.name;
		if (operation.kind === 'set') {
			saved.set(key, operation.value);
			return Response.json({ result: null });
		}
		if (operation.kind === 'remove') {
			saved.delete(key);
			return Response.json({ result: null });
		}
		if (operation.kind === 'has') {
			return Response.json({ result: saved.has(key) });
		}
		return Response.json({ result: ref });
	});
	return { send, scope };
}
it('registers game-only secrets through the real frame and uses references through a scoped Action Worker', async () => {
	const token = 'test-browser-secret-not-real',
		ref = 'helia-secret:v1:novelai:' + 'a'.repeat(64);
	const { send, scope } = mockSecretServer(token, ref);
	vi.stubGlobal('fetch', send);
	const game = await createGame();
	scope.gameId = game.id;
	await updateGameRules(game.id, {
		schema: {
			type: 'object',
			properties: { checks: { type: 'array', items: { type: 'string' } } },
			additionalProperties: false
		},
		initialState: { checks: [] },
		scripts: {
			main: {
				language: 'typescript',
				source: `
helia.defineAction<{gameId:string}>({name:'probe',async run({state}){if(!await helia.secrets.has('novelai'))throw Error('missing');const ref=await helia.secrets.ref('novelai');const response=await fetch('https://image.example/generate',{headers:{Authorization:'Bearer '+ref}});if(!response.ok)throw Error('request');state.checks.push('used');return state;}});
helia.defineAction<{text:string}>({name:'check',run({state,args}){state.checks.push(args.text);return state;}});`
			}
		},
		ui: {
			version: 1,
			entry: 'ui.tsx',
			modules: {
				'ui.tsx': {
					language: 'tsx',
					source: `
import {secrets,action} from '@helia/ui';
setTimeout(()=>{void(async()=>{await secrets.set('novelai',globalThis.name,{url:'https://image.example/generate'});if(!await secrets.has('novelai'))throw Error('not saved');await action('probe',{gameId:'other-game'});await action('check',{text:'shared'});})().catch(error=>action('check',{text:'failed:'+error.message}));},30);`
				}
			}
		}
	});
	const frame = document.createElement('iframe');
	frame.name = token;
	document.body.append(frame);
	disposers.push(await mountGameUI(frame, game.id, game.activeSessionId));
	await expect
		.poll(
			async () => (await getSessionHistory(game.id, game.activeSessionId)).progress.state.checks,
			{ timeout: 20000 }
		)
		.toEqual(['used', 'shared']);
	const client = gameSecrets(game.id);
	expect(await client.has('novelai')).toBe(true);
	const other = await createGame();
	expect(await gameSecrets(other.id).has('novelai')).toBe(false);
	await createSession(game.id);
	expect(await client.has('novelai')).toBe(true);
	const timeline = await getSessionTimeline(game.id, game.activeSessionId);
	expect(
		JSON.stringify({
			state: timeline.history.progress.state,
			transactions: timeline.history.transactions,
			messages: timeline.messages
		})
	).not.toContain(token);
	await client.remove('novelai');
	expect(await client.has('novelai')).toBe(false);
}, 30000);
