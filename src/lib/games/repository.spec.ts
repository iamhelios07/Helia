import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '#lib/server/sqlite.js';
import { createGameRepository } from './repository-core.js';
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
	await repository.updateGameRules(game.id, { initialState: { gold: 100 }, scripts: {} });
	return {
		gameId: game.id,
		sessionId: game.activeSessionId,
		history: await repository.getSessionHistory(game.id, game.activeSessionId)
	};
}

describe('SQLite game repository', () => {
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
		expect(hidden.transactions).toHaveLength(2);
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
		await repository.updateGameRules(gameId, { initialState: { gold: 500 }, scripts: {} });
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
