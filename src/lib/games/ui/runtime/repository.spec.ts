import { afterEach, describe, expect, it } from 'vitest';

import { createGameRepository } from '#lib/games/repository-core.js';
import { openStorage } from '#lib/server/sqlite.js';
import { parseReply } from '#lib/storage/protocol.js';

const connections: ReturnType<typeof openStorage>[] = [];
function repository() {
	const storage = openStorage(':memory:');
	connections.push(storage);
	return createGameRepository(async (request) => parseReply(storage.request(request)));
}
afterEach(() => {
	for (const storage of connections.splice(0)) {
		storage.close();
	}
});
const ui = {
	version: 1,
	entry: 'main.tsx',
	modules: { 'main.tsx': { language: 'tsx', source: 'export default function(){}' } }
} as const;
describe('UI content and committed-state observers', () => {
	it('roundtrips UI content and pins it to session snapshots', async () => {
		const repo = repository();
		const game = await repo.createGame();
		await repo.updateGameRules(game.id, {
			schema: game.schema,
			initialState: game.initialState,
			scripts: {},
			ui
		});
		expect((await repo.getGameWorkspace(game.id))!.game.ui).toEqual(ui);
		const first = await repo.getSessionHistory(game.id, game.activeSessionId);
		await repo.updateGameRules(game.id, {
			schema: game.schema,
			initialState: game.initialState,
			scripts: {},
			ui: { ...ui, entry: 'next.tsx', modules: { 'next.tsx': ui.modules['main.tsx'] } }
		});
		expect((await repo.getSessionHistory(game.id, game.activeSessionId)).snapshot.ui).toEqual(
			first.snapshot.ui
		);
	});
	it('publishes only successful writes for the selected session and stops after unsubscribe', async () => {
		const repo = repository();
		const game = await repo.createGame();
		const a = game.activeSessionId,
			b = (await repo.createSession(game.id)).id;
		await repo.getSessionHistory(game.id, a);
		await repo.getSessionHistory(game.id, b);
		let calls = 0;
		const off = repo.subscribeSessionChanges(game.id, a, () => {
			calls++;
		});
		await repo.appendUserMessage(game.id, b, 'other session');
		expect(calls).toBe(0);
		await repo.appendUserMessage(game.id, a, 'first');
		expect(calls).toBe(1);
		const history = await repo.getSessionHistory(game.id, a);
		await expect(
			repo.selectSessionBranch(game.id, a, null, history.progress.revision + 1)
		).rejects.toThrow();
		expect(calls).toBe(1);
		off();
		await repo.appendUserMessage(game.id, a, 'second');
		expect(calls).toBe(1);
	});
});
