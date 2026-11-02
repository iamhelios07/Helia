import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '#lib/server/sqlite.js';
import { createGameRepository } from './repository-core.js';
import { createWorkspace, TransactionFailure } from '#lib/game-runtime/workspace.js';
import {
	CONFLICT,
	parseReply,
	storedRecord,
	type StorageTransport
} from '#lib/storage/protocol.js';

let directory: string;
let storage: ReturnType<typeof openStorage>;
let repository: ReturnType<typeof createGameRepository>;
const transport: StorageTransport = async (request) =>
	parseReply(storage.request(JSON.parse(JSON.stringify(request))));
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'helia-sqlite-'));
	storage = openStorage(join(directory, 'helia.sqlite'));
	repository = createGameRepository(transport);
});
afterEach(() => {
	storage.close();
	rmSync(directory, { recursive: true, force: true });
});

async function start() {
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
	return {
		gameId: game.id,
		sessionId: game.activeSessionId,
		history: await repository.getSessionHistory(game.id, game.activeSessionId)
	};
}

/** A–B–C–D / B–E–F, with messages and memories spanning both futures. */
async function branchedHistory() {
	const { gameId, sessionId } = await start();
	const ids: Record<string, string> = {};
	let revision = 0;
	for (const [name, parent, gold] of [
		['A', null, 90],
		['B', 'A', 80],
		['C', 'B', 70],
		['D', 'C', 60],
		['E', 'B', 50],
		['F', 'E', 40]
	] as const) {
		const saved = await repository.commitSessionTransaction(gameId, sessionId, {
			expectedRevision: revision,
			parentId: parent ? ids[parent] : null,
			nextState: { gold },
			action: { name, args: {} },
			description: `Event ${name}`,
			message: { role: 'assistant', content: name }
		});
		revision = saved.progress.revision;
		ids[name] = saved.progress.headId!;
		await repository.saveSessionMemory(gameId, sessionId, revision, {
			sourceTransactionIds: [ids.A, ids[name]],
			content: `Memory ${name}`
		});
	}
	return { gameId, sessionId, ids, revision };
}

describe('SQLite game repository', () => {
	it.each(['B', 'E'])(
		'deletes the entire %s subtree and restores the nearest surviving ancestor after reopening',
		async (target) => {
			const { gameId, sessionId, ids, revision } = await branchedHistory();
			const before = await repository.getSessionTimeline(gameId, sessionId);
			expect(before.events.map((event) => event.summary)).toEqual([
				'Event A',
				'Event B',
				'Event C',
				'Event D',
				'Event E',
				'Event F'
			]);
			expect(before.events.map((event) => event.depth)).toEqual([0, 1, 2, 3, 2, 3]);
			expect(
				before.events.filter((event) => event.active).map((event) => event.action.name)
			).toEqual(['A', 'B', 'E', 'F']);
			const saved = await repository.deleteSessionEvent(gameId, sessionId, ids[target], revision);
			const kept = target === 'B' ? ['A'] : ['A', 'B', 'C', 'D'];
			expect(saved.events.map((event) => event.action.name)).toEqual(kept);
			expect(saved.history.progress).toMatchObject({
				headId: ids[target === 'B' ? 'A' : 'B'],
				revision: revision + 1,
				state: { gold: target === 'B' ? 90 : 80 }
			});
			expect(saved.messages.map((message) => message.content)).toEqual(
				target === 'B' ? ['A'] : ['A', 'B']
			);
			const records = (await transport({ kind: 'read', gameId, sessionId })).records;
			const messages = records
				.filter((row) => row.table === 'messages')
				.map((row) => row.value as { id: string; content: string; sequence: number })
				.sort((a, b) => a.sequence - b.sequence);
			expect(messages.map((message) => message.content)).toEqual(kept);
			expect(messages.map((message) => message.sequence)).toEqual(
				kept.map((_, index) => index + 1)
			);
			expect(messages.map((message) => message.id)).toEqual(
				before.events
					.filter((event) => kept.includes(event.action.name))
					.map((event) => event.message!.id)
			);
			expect(records.filter((row) => row.table === 'memories')).toHaveLength(kept.length);
			storage.close();
			storage = openStorage(join(directory, 'helia.sqlite'));
			expect(await repository.getSessionTimeline(gameId, sessionId)).toEqual(saved);
			const continued = await repository.commitSessionTransaction(gameId, sessionId, {
				expectedRevision: revision + 1,
				parentId: saved.history.progress.headId,
				nextState: { gold: 25 },
				action: { name: 'new', args: {} },
				message: { role: 'user', content: 'new' }
			});
			expect(continued.transactions).toHaveLength(kept.length + 1);
		}
	);
	it('keeps the selected future when deleting an inactive branch, then restores initial state when deleting the root', async () => {
		const { gameId, sessionId, ids, revision } = await branchedHistory();
		let saved = await repository.deleteSessionEvent(gameId, sessionId, ids.C, revision);
		expect(saved.history.progress).toMatchObject({
			headId: ids.F,
			revision: revision + 1,
			state: { gold: 40 }
		});
		expect(saved.messages.map((message) => message.content)).toEqual(['A', 'B', 'E', 'F']);
		expect(saved.memories.map((memory) => memory.content)).toEqual([
			'Memory A',
			'Memory B',
			'Memory E',
			'Memory F'
		]);
		saved = await repository.deleteSessionEvent(gameId, sessionId, ids.A, revision + 1);
		expect(saved.history.progress).toMatchObject({
			headId: null,
			revision: revision + 2,
			state: { gold: 100 }
		});
		expect(saved.events).toEqual([]);
		expect(saved.messages).toEqual([]);
		expect(saved.memories).toEqual([]);
	});
	it.each(['transactions', 'progress', 'games'])(
		'rolls back subtree deletion and sequence compaction if %s fails',
		async (table) => {
			const { gameId, sessionId, ids, revision } = await branchedHistory();
			const before = await transport({ kind: 'read', gameId, sessionId });
			storage.connection.exec(
				`CREATE TRIGGER fail_prune ${table === 'transactions' ? 'AFTER DELETE' : 'BEFORE UPDATE'} ON ${table} BEGIN SELECT RAISE(ABORT,'forced failure'); END`
			);
			await expect(
				repository.deleteSessionEvent(gameId, sessionId, ids.C, revision)
			).rejects.toThrow();
			expect(await transport({ kind: 'read', gameId, sessionId })).toEqual(before);
		}
	);
	it('rejects stale revisions and foreign event ownership without deleting anything', async () => {
		const { gameId, sessionId, ids, revision } = await branchedHistory();
		const other = await repository.createSession(gameId);
		const before = await transport({ kind: 'read', gameId, sessionId });
		await expect(
			repository.deleteSessionEvent(gameId, sessionId, ids.E, revision - 1)
		).rejects.toThrow();
		await expect(repository.deleteSessionEvent(gameId, other.id, ids.E, 0)).rejects.toThrow();
		await expect(
			repository.deleteSessionEvent('foreign', sessionId, ids.E, revision)
		).rejects.toThrow();
		expect(await transport({ kind: 'read', gameId, sessionId })).toEqual(before);
	});
	it('allows exactly one of a pending commit and deletion using the same revision', async () => {
		const { gameId, sessionId, ids, revision } = await branchedHistory();
		const results = await Promise.allSettled([
			repository.commitSessionTransaction(gameId, sessionId, {
				expectedRevision: revision,
				parentId: ids.F,
				nextState: { gold: 30 },
				action: { name: 'pending', args: {} }
			}),
			repository.deleteSessionEvent(gameId, sessionId, ids.E, revision)
		]);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect((await repository.getSessionHistory(gameId, sessionId)).progress.revision).toBe(
			revision + 1
		);
	});
	it('rejects invalid schemas and initial states before writing game rules', async () => {
		const game = await repository.createGame();
		const before = await transport({ kind: 'read', gameId: game.id });
		for (const input of [
			{ schema: { type: 'object', properties: {}, additionalProperties: true }, initialState: {} },
			{
				schema: {
					type: 'object',
					properties: { hp: { type: 'integer' } },
					required: ['hp'],
					additionalProperties: false
				},
				initialState: { hp: '100' }
			}
		])
			expect(() =>
				repository.updateGameRules(game.id, { ...input, scripts: {} } as unknown as Parameters<
					typeof repository.updateGameRules
				>[1])
			).toThrow();
		expect(await transport({ kind: 'read', gameId: game.id })).toEqual(before);
	});
	it('commits accumulated workspace steps once and rolls back schema or rule failures with messages', async () => {
		const { gameId, sessionId, history } = await start();
		const work = createWorkspace(history.snapshot.schema, history.progress.state);
		work.replace({ gold: 90 });
		work.replace({ gold: 80 });
		const input = {
			expectedRevision: 0,
			parentId: null,
			nextState: work.finish({ name: 'buy', args: {} }).state,
			action: { name: 'buy', args: {} },
			message: { role: 'assistant' as const, content: 'done' }
		};
		const before = await transport({ kind: 'read', gameId, sessionId });
		await expect(
			repository.commitSessionTransaction(gameId, sessionId, {
				...input,
				nextState: { gold: 'invalid' }
			})
		).rejects.toThrow(/commit/);
		for (const phase of ['filter', 'hook'] as const) {
			const guarded = createGameRepository(transport, {
				validateTransaction() {
					throw new TransactionFailure(phase, 'test', 'rejected');
				}
			});
			await expect(guarded.commitSessionTransaction(gameId, sessionId, input)).rejects.toThrow(
				TransactionFailure
			);
			expect(await transport({ kind: 'read', gameId, sessionId })).toEqual(before);
		}
		const saved = await repository.commitSessionTransaction(gameId, sessionId, input);
		expect(saved.transactions).toHaveLength(1);
		expect(saved.progress.state).toEqual({ gold: 80 });
	});
	it('rejects raw storage proposals that bypass state schema or history validation and rolls back metadata', async () => {
		const { gameId, sessionId, history } = await start();
		const before = await transport({ kind: 'read', gameId, sessionId });
		const game = (await repository.getGameWorkspace(gameId))!.game;
		for (const state of [{ gold: 'invalid' }, { gold: 100, extra: true }, { gold: 50 }]) {
			expect(() =>
				storage.request({
					kind: 'commit',
					gameId,
					version: before.version,
					deleteSessions: [],
					records: [
						storedRecord('games', { ...game, title: 'must roll back' }),
						storedRecord('progress', { ...history.progress, state })
					]
				})
			).toThrow();
			expect(await transport({ kind: 'read', gameId, sessionId })).toEqual(before);
		}
	});
	it('validates loaded state without silently repairing corrupt data', async () => {
		const { gameId, sessionId } = await start();
		storage.connection
			.prepare("UPDATE progress SET value=json_set(value,'$.state.gold','bad') WHERE id=?")
			.run(sessionId);
		await expect(repository.getSessionHistory(gameId, sessionId)).rejects.toThrow();
		expect(
			storage.connection
				.prepare("SELECT json_extract(value,'$.state.gold') as gold FROM progress WHERE id=?")
				.get(sessionId)
		).toEqual({ gold: 'bad' });
	});
	it('rejects a corrupted inactive branch even when current progress still matches its own history', async () => {
		const { gameId, sessionId } = await start();
		const history = await repository.commitSessionTransaction(gameId, sessionId, {
			expectedRevision: 0,
			parentId: null,
			nextState: { gold: 80 },
			action: { name: 'buy', args: {} }
		});
		await repository.selectSessionBranch(gameId, sessionId, null, history.progress.revision);
		storage.connection
			.prepare(
				"UPDATE transactions SET value=json_set(value,'$.changes[0].after.value','bad') WHERE id=?"
			)
			.run(history.progress.headId);
		await expect(repository.getSessionHistory(gameId, sessionId)).rejects.toThrow(/load/);
	});
	it('creates independent games and initial sessions in a fresh DB', async () => {
		const first = await repository.createGame();
		const second = await repository.createGame();
		expect(first.id).not.toBe(second.id);
		expect(await repository.listGames()).toHaveLength(2);
		expect((await repository.getGameWorkspace(first.id))?.sessions[0].id).toBe(
			first.activeSessionId
		);
		expect(await repository.getGameWorkspace('missing')).toBeNull();
	});
	it('preserves game metadata, prompts and IDs when reopening the file', async () => {
		const game = await repository.createGame({ title: '게임', genre: '자유', description: '소개' });
		await repository.updateGameSettings(game.id, {
			title: '새 이름',
			description: '  지침\n',
			firstMessage: '\n첫 장면',
			authorNote: '메모 🧪'
		});
		const before = await repository.getGameWorkspace(game.id);
		storage.close();
		storage = openStorage(join(directory, 'helia.sqlite'));
		expect(await repository.getGameWorkspace(game.id)).toEqual(before);
		expect(before?.game.description).toBe('소개');
	});
	it('creates, selects, renames and deletes sessions while maintaining selection', async () => {
		const game = await repository.createGame();
		const second = await repository.createSession(game.id);
		expect((await repository.getGameWorkspace(game.id))?.game.activeSessionId).toBe(second.id);
		expect((await repository.renameSession(game.id, second.id, ' 이름 ')).title).toBe('이름');
		await repository.selectSession(game.id, game.activeSessionId);
		expect((await repository.deleteSession(game.id, second.id)).game.activeSessionId).toBe(
			game.activeSessionId
		);
		const replacement = await repository.deleteSession(game.id, game.activeSessionId);
		expect(replacement.sessions).toHaveLength(1);
		expect(replacement.game.activeSessionId).not.toBe(game.activeSessionId);
	});
	it('rejects missing or foreign session mutations without changing games', async () => {
		const first = await repository.createGame();
		const second = await repository.createGame();
		const before = await repository.listGames();
		for (const id of ['missing', second.activeSessionId]) {
			await expect(repository.selectSession(first.id, id)).rejects.toThrow();
			await expect(repository.deleteSession(first.id, id)).rejects.toThrow();
			await expect(repository.renameSession(first.id, id, 'name')).rejects.toThrow();
		}
		expect(await repository.listGames()).toEqual(before);
	});
	it('prepends an opening exactly once and preserves dialogue through settings edits', async () => {
		const game = await repository.createGame();
		await repository.appendUserMessage(game.id, game.activeSessionId, '  행동\n대사  ');
		await repository.updateGameSettings(game.id, {
			title: game.title,
			description: '',
			firstMessage: '첫 장면',
			authorNote: ''
		});
		const results = await Promise.all(
			Array.from({ length: 3 }, () =>
				repository.getSessionConversation(game.id, game.activeSessionId)
			)
		);
		expect(results[0].messages.map((m) => m.content)).toEqual(['첫 장면', '  행동\n대사  ']);
		expect(results.every((value) => value.messages.length === 2)).toBe(true);
		await repository.updateGameSettings(game.id, {
			title: game.title,
			description: '',
			firstMessage: '다른 장면',
			authorNote: ''
		});
		expect(
			(await repository.getSessionConversation(game.id, game.activeSessionId)).messages[0].content
		).toBe('첫 장면');
	});
	it('serializes competing normal sends without losing or duplicating messages', async () => {
		const game = await repository.createGame();
		await Promise.all(
			Array.from({ length: 6 }, (_, i) =>
				repository.appendUserMessage(game.id, game.activeSessionId, `입력 ${i}`)
			)
		);
		const conversation = await repository.getSessionConversation(game.id, game.activeSessionId);
		expect(conversation.messages.map((m) => m.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(new Set(conversation.messages.map((m) => m.content)).size).toBe(6);
		expect(
			(await repository.getSessionHistory(game.id, game.activeSessionId)).transactions
		).toHaveLength(6);
	});
	it('rejects invalid inputs without initializing partial data', async () => {
		expect(() =>
			repository.updateGame('missing', { title: '', genre: '', description: '' })
		).toThrow();
		const game = await repository.createGame();
		expect(() => repository.appendUserMessage(game.id, game.activeSessionId, ' \n')).toThrow();
		expect(storage.connection.prepare('select count(*) as count from progress').get()).toEqual({
			count: 0
		});
	});
	it('rolls back game creation when its initial session cannot be inserted', async () => {
		storage.connection.exec(
			"CREATE TRIGGER fail_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'forced failure'); END"
		);
		await expect(repository.createGame()).rejects.toThrow();
		expect(await repository.listGames()).toEqual([]);
	});
	it('atomically records state, response and event and rejects competing stale results', async () => {
		const { gameId, sessionId, history } = await start();
		const input = {
			expectedRevision: history.progress.revision,
			parentId: null,
			nextState: { gold: 80 },
			action: { name: 'buy', args: {} },
			message: { role: 'assistant' as const, content: '물약을 샀다. 🧪' }
		};
		const results = await Promise.allSettled([
			repository.commitSessionTransaction(gameId, sessionId, input),
			repository.commitSessionTransaction(gameId, sessionId, input)
		]);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		const saved = await repository.getSessionHistory(gameId, sessionId);
		expect(saved.progress.state).toEqual({ gold: 80 });
		expect(saved.transactions).toHaveLength(1);
		expect((await repository.getSessionConversation(gameId, sessionId)).messages).toHaveLength(1);
	});
	it('rolls back every write, including version and metadata, if the event insert fails', async () => {
		const { gameId, sessionId, history } = await start();
		const before = await transport({ kind: 'read', gameId, sessionId });
		storage.connection.exec(
			"CREATE TRIGGER fail_event BEFORE INSERT ON transactions BEGIN SELECT RAISE(ABORT,'forced failure'); END"
		);
		await expect(
			repository.commitSessionTransaction(gameId, sessionId, {
				expectedRevision: 0,
				parentId: null,
				nextState: { gold: 80 },
				action: { name: 'buy', args: {} },
				message: { role: 'assistant', content: 'failed' }
			})
		).rejects.toThrow();
		expect(await transport({ kind: 'read', gameId, sessionId })).toEqual(before);
		expect((await repository.getSessionHistory(gameId, sessionId)).progress).toEqual(
			history.progress
		);
	});
	it('restores branches and isolates memories, including after reopening', async () => {
		const { gameId, sessionId } = await start();
		let a = await repository.commitSessionTransaction(gameId, sessionId, {
			expectedRevision: 0,
			parentId: null,
			nextState: { gold: 80 },
			action: { name: 'A', args: {} },
			message: { role: 'assistant', content: 'A' }
		});
		await repository.saveSessionMemory(gameId, sessionId, a.progress.revision, {
			sourceTransactionIds: [a.progress.headId!],
			content: 'A 기억'
		});
		const b = await repository.commitSessionTransaction(gameId, sessionId, {
			expectedRevision: a.progress.revision,
			parentId: null,
			nextState: { gold: 50 },
			action: { name: 'B', args: {} },
			message: { role: 'assistant', content: 'B' }
		});
		expect(await repository.listSessionMemories(gameId, sessionId)).toEqual([]);
		expect(
			(await repository.getSessionConversation(gameId, sessionId)).messages.map((m) => m.content)
		).toEqual(['B']);
		a = await repository.selectSessionBranch(
			gameId,
			sessionId,
			a.progress.headId,
			b.progress.revision
		);
		storage.close();
		storage = openStorage(join(directory, 'helia.sqlite'));
		expect((await repository.getSessionHistory(gameId, sessionId)).progress).toEqual(a.progress);
		expect(await repository.listSessionMemories(gameId, sessionId)).toHaveLength(1);
		const hidden = await repository.deleteSessionResponse(
			gameId,
			sessionId,
			a.progress.headId!,
			a.progress.revision
		);
		expect(hidden.progress.state).toEqual({ gold: 100 });
		expect(hidden.transactions).toHaveLength(1);
	});
	it('cascades session deletion to its messages, progress, snapshots, events and memories', async () => {
		const { gameId, sessionId } = await start();
		const history = await repository.commitSessionTransaction(gameId, sessionId, {
			expectedRevision: 0,
			parentId: null,
			nextState: { gold: 80 },
			action: { name: 'buy', args: {} },
			message: { role: 'assistant', content: 'ok' }
		});
		await repository.saveSessionMemory(gameId, sessionId, history.progress.revision, {
			sourceTransactionIds: [history.progress.headId!],
			content: '기억'
		});
		await repository.deleteSession(gameId, sessionId);
		for (const table of ['messages', 'progress', 'snapshots', 'transactions', 'memories'])
			expect(storage.connection.prepare(`select count(*) as count from ${table}`).get()).toEqual({
				count: 0
			});
		expect((await repository.getGameWorkspace(gameId))?.sessions).toHaveLength(1);
	});
	it('does not delete a session if updating its game fails', async () => {
		const { gameId, sessionId } = await start();
		const before = await transport({ kind: 'read', gameId, sessionId });
		storage.connection.exec(
			"CREATE TRIGGER fail_game BEFORE UPDATE OF value ON games BEGIN SELECT RAISE(ABORT,'forced failure'); END"
		);
		await expect(repository.deleteSession(gameId, sessionId)).rejects.toThrow();
		expect(await transport({ kind: 'read', gameId, sessionId })).toEqual(before);
	});
	it('keeps state and script snapshots independent between sessions', async () => {
		const { gameId, sessionId, history } = await start();
		await repository.updateGameRules(gameId, {
			schema: {
				type: 'object',
				properties: { gold: { type: 'integer' } },
				additionalProperties: false
			},
			initialState: { gold: 500 },
			scripts: {}
		});
		const other = await repository.createSession(gameId);
		expect((await repository.getSessionHistory(gameId, other.id)).progress.state).toEqual({
			gold: 500
		});
		expect((await repository.getSessionHistory(gameId, sessionId)).snapshot).toEqual(
			history.snapshot
		);
	});
	it('rejects unknown operations, table names and mismatched owners before writing', async () => {
		const game = await repository.createGame();
		const view = await transport({ kind: 'read', gameId: game.id });
		expect(() => storage.request({ kind: 'sql', query: 'DROP TABLE games' })).toThrow();
		expect(() =>
			storage.request({
				kind: 'commit',
				gameId: game.id,
				version: view.version,
				deleteSessions: [],
				records: [{ table: 'games; DROP TABLE games', id: game.id, value: game }]
			})
		).toThrow();
		expect(() =>
			storage.request({
				kind: 'commit',
				gameId: 'foreign',
				version: view.version,
				deleteSessions: [],
				records: [storedRecord('games', game)]
			})
		).toThrow();
		expect(await repository.listGames()).toHaveLength(1);
	});
	it('rejects stale storage versions without changing records', async () => {
		const game = await repository.createGame();
		await repository.updateGame(game.id, { title: 'new', genre: '', description: '' });
		expect(() =>
			storage.request({
				kind: 'commit',
				gameId: game.id,
				version: 0,
				records: [],
				deleteSessions: []
			})
		).toThrow(CONFLICT);
		expect((await repository.getGameWorkspace(game.id))?.game.title).toBe('new');
	});
});
