import { expect, it } from 'vitest';

import { createGameRepository } from '#lib/games/repository-core.js';

import { openStorage } from './sqlite.js';

it('keeps restored games in active listings and writable while trashedAt is null', async () => {
	const store = openStorage(':memory:');
	const repository = createGameRepository(async (request) => store.request(request));
	const game = await repository.createGame();
	await repository.updateGameRules(game.id, {
		schema: {
			type: 'object',
			properties: { gold: { type: 'integer' } },
			additionalProperties: false
		},
		initialState: { gold: 100 },
		scripts: {}
	});
	const first = await repository.commitSessionTransaction(game.id, game.activeSessionId, {
		expectedRevision: 0,
		parentId: null,
		nextState: { gold: 90 },
		action: { name: 'move', args: {} },
		message: { role: 'assistant', content: 'Move' }
	});
	await repository.trashGame(game.id);
	expect(await repository.listGames()).toEqual([]);
	await repository.restoreGame(game.id);
	expect((await repository.listGames()).map((row) => row.id)).toEqual([game.id]);
	// A restored game is not in the Trash, so permanent removal stays refused.
	await expect(repository.purgeGame(game.id)).rejects.toThrow(
		'휴지통에 있는 게임만 삭제할 수 있어요.'
	);
	const second = await repository.commitSessionTransaction(game.id, game.activeSessionId, {
		expectedRevision: first.progress.revision,
		parentId: first.progress.headId,
		nextState: { gold: 80 },
		action: { name: 'move', args: {} },
		message: { role: 'assistant', content: 'Again' }
	});
	const pruned = await repository.deleteSessionResponse(
		game.id,
		game.activeSessionId,
		second.progress.headId!,
		second.progress.revision
	);
	expect(pruned.progress.headId).toBe(first.progress.headId);
	store.close();
});
