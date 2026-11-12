import { expect, it } from 'vitest';

import { createGameRepository } from '#lib/games/repository-core.js';
import { openStorage } from '#lib/server/sqlite.js';

it('moves games to Trash, restores them and purges permanently', async () => {
	const store = openStorage(':memory:');
	const repo = createGameRepository(async (request) => store.request(request));
	const game = await repo.createGame();
	const other = await repo.createGame();
	// Active listings exclude trashed games; the trashed one keeps its data.
	await repo.trashGame(game.id);
	const active = await repo.listGames();
	const everything = await repo.listGames(true);
	expect(active.map((row) => row.id)).toEqual([other.id].sort());
	expect([...everything.map((row) => row.id)].sort()).toEqual([game.id, other.id].sort());
	expect(everything.find((row) => row.id === game.id)?.trashedAt).toBeTruthy();
	// Writes are refused while in the Trash.
	await expect(
		repo.updateGameRules(game.id, {
			schema: { type: 'object', properties: {}, additionalProperties: false },
			initialState: {},
			scripts: {}
		})
	).rejects.toThrow('휴지통에 있는 게임은 변경할 수 없어요.');
	// Restore brings everything back untouched.
	const restored = await repo.restoreGame(game.id);
	expect(restored.trashedAt).toBeUndefined();
	expect((await repo.listGames()).map((row) => row.id).sort()).toEqual([game.id, other.id].sort());
	// Trash again, then purge permanently removes the game and all owned rows.
	await repo.trashGame(game.id);
	await repo.purgeGame(game.id);
	expect((await repo.listGames(true)).map((row) => row.id)).toEqual([other.id]);
	const rows = store.connection.prepare('select count(*) as count from sessions').get() as {
		count: number;
	};
	expect(rows.count).toBe(1);
});
