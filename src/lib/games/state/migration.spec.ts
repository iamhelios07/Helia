import { afterEach, expect, it } from 'vitest';

import { openStorage } from '#lib/server/sqlite.js';

import { editorContent } from '../editor.js';
import { createGameRepository } from '../repository-core.js';
import { stateAt } from './engine.js';
import { parseObjectSchema } from './schema.js';
const stores: ReturnType<typeof openStorage>[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) {
		store.close();
	}
});
const object = (properties: Record<string, unknown>) =>
	parseObjectSchema({
		type: 'object',
		properties,
		required: Object.keys(properties),
		additionalProperties: false
	});
async function fixture() {
	const store = openStorage(':memory:');
	stores.push(store);
	const repo = createGameRepository(async (request) => store.request(request));
	const created = await repo.createGame();
	const schema = object({
		hp: { type: 'integer' },
		old: { type: 'string' },
		items: { type: 'array', items: object({ name: { type: 'string' } }) }
	});
	await repo.updateGameRules(created.id, {
		schema,
		initialState: { hp: 100, old: 'remove', items: [{ name: 'sword' }] },
		scripts: {}
	});
	const game = (await repo.getGameWorkspace(created.id))!.game;
	const first = await repo.getSessionHistory(game.id, game.activeSessionId);
	const a = await repo.commitSessionTransaction(game.id, game.activeSessionId, {
		expectedRevision: first.progress.revision,
		parentId: null,
		nextState: { hp: 80, old: 'remove', items: [{ name: 'shield' }] },
		action: { name: 'A', args: {} }
	});
	const b = await repo.commitSessionTransaction(game.id, game.activeSessionId, {
		expectedRevision: a.progress.revision,
		parentId: a.progress.headId,
		nextState: { hp: 60, old: 'remove', items: [{ name: 'armor' }] },
		action: { name: 'B', args: {} }
	});
	const c = await repo.commitSessionTransaction(game.id, game.activeSessionId, {
		expectedRevision: b.progress.revision,
		parentId: a.progress.headId,
		nextState: { hp: 40, old: 'remove', items: [{ name: 'potion' }] },
		action: { name: 'C', args: {} }
	});
	const other = await repo.createSession(game.id);
	await repo.getSessionHistory(game.id, other.id);
	return { store, repo, game, a, b, c, other };
}
it('migrates every session and inactive branch atomically while preserving recorded outcomes', async () => {
	const { repo, store, game, a, b, c, other } = await fixture();
	const rawBefore = store.connection.prepare('SELECT id,value FROM transactions ORDER BY id').all();
	const content = {
		...editorContent(game),
		schema: object({
			hp: { type: 'string' },
			score: { type: 'integer' },
			items: {
				type: 'array',
				items: object({ name: { type: 'string' }, equipped: { type: 'boolean' } })
			}
		}),
		initialState: { hp: '999', score: 0, items: [{ name: 'new default', equipped: false }] }
	};
	await repo.applyGameDraft(game.id, { baseContent: editorContent(game), content });
	const migrated = await repo.getSessionHistory(game.id, game.activeSessionId);
	expect(migrated.progress.state).toEqual({
		hp: '40',
		score: 0,
		items: [{ name: 'potion', equipped: false }]
	});
	expect(stateAt(migrated, a.progress.headId)).toEqual({
		hp: '80',
		score: 0,
		items: [{ name: 'shield', equipped: false }]
	});
	expect(stateAt(migrated, b.progress.headId).hp).toBe('60');
	expect((await repo.getSessionHistory(game.id, other.id)).progress.state.hp).toBe('100');
	expect(store.connection.prepare('SELECT id,value FROM transactions ORDER BY id').all()).toEqual(
		rawBefore
	);
	expect(migrated.transactions).toEqual(c.transactions);
	// New transactions build on transformed history; a second apply preserves them too.
	const next = await repo.commitSessionTransaction(game.id, game.activeSessionId, {
		expectedRevision: migrated.progress.revision,
		parentId: migrated.progress.headId,
		nextState: { ...migrated.progress.state, hp: '25' },
		action: { name: 'D', args: {} }
	});
	const current = (await repo.getGameWorkspace(game.id))!.game;
	await repo.applyGameDraft(game.id, {
		baseContent: editorContent(current),
		content: { ...editorContent(current), settings: { ...current.settings, authorNote: 'updated' } }
	});
	const latest = await repo.getSessionHistory(game.id, game.activeSessionId);
	expect(latest.progress.state.hp).toBe('25');
	expect(stateAt(latest, next.progress.headId).hp).toBe('25');
	expect(latest.snapshot.settings.authorNote).toBe('updated');
	// Pruning removes restoration checkpoints for the deleted subtree, including old snapshots.
	await repo.deleteSessionEvent(
		game.id,
		game.activeSessionId,
		b.progress.headId!,
		latest.progress.revision
	);
	const after = await repo.getSessionHistory(game.id, game.activeSessionId);
	expect(after.progress.state.hp).toBe('25');
	const rows = store.connection.prepare('SELECT value FROM snapshots').all() as { value: string }[];
	expect(
		rows.every(
			(row) => !Object.hasOwn(JSON.parse(row.value).restoredStates ?? {}, b.progress.headId!)
		)
	).toBe(true);
});
it('cancels the whole apply when any historical branch fails target validation', async () => {
	const { repo, store, game } = await fixture();
	const before = store.connection.prepare('SELECT version,value FROM games').all();
	const snapshots = store.connection.prepare('SELECT value FROM snapshots').all();
	const content = {
		...editorContent(game),
		schema: object({
			hp: { type: 'integer', enum: [40, 100] },
			old: { type: 'string' },
			items: { type: 'array', items: object({ name: { type: 'string' } }) }
		})
	};
	await expect(
		repo.applyGameDraft(game.id, { baseContent: editorContent(game), content })
	).rejects.toThrow();
	expect(store.connection.prepare('SELECT version,value FROM games').all()).toEqual(before);
	expect(store.connection.prepare('SELECT value FROM snapshots').all()).toEqual(snapshots);
});
it('falls back to new initial values when type conversion fails, including array fields', async () => {
	const { repo, game } = await fixture();
	const content = {
		...editorContent(game),
		schema: object({
			hp: { type: 'integer' },
			old: { type: 'integer' },
			items: { type: 'array', items: object({ name: { type: 'integer' } }) }
		}),
		initialState: { hp: 100, old: 7, items: [{ name: 12 }] }
	};
	await repo.applyGameDraft(game.id, { baseContent: editorContent(game), content });
	const history = await repo.getSessionHistory(game.id, game.activeSessionId);
	expect(history.progress.state).toEqual({ hp: 40, old: 7, items: [{ name: 12 }] });
	expect(stateAt(history, null)).toEqual({ hp: 100, old: 7, items: [{ name: 12 }] });
});
