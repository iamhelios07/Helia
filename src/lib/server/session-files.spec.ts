import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { FILE_LIMITS } from '#lib/games/files/model.js';
import { createGameRepository } from '#lib/games/repository-core.js';

import { sessionFileStorage } from './session-files.js';
import { openStorage } from './sqlite.js';

const cleanups: (() => void)[] = [];
afterEach(() =>
	cleanups
		.splice(0)
		.reverse()
		.forEach((cleanup) => cleanup())
);
async function fixture(filename = ':memory:') {
	const database = openStorage(filename);
	cleanups.push(() => database.close());
	const repo = createGameRepository(async (input) => database.request(input));
	const game = await repo.createGame();
	await repo.updateGameRules(game.id, {
		schema: {
			type: 'object',
			properties: { image: { type: 'string' } },
			required: ['image'],
			additionalProperties: false
		},
		initialState: { image: '' },
		scripts: {}
	});
	await repo.getSessionTimeline(game.id, game.activeSessionId);
	return {
		database,
		repo,
		game,
		scope: { gameId: game.id, sessionId: game.activeSessionId },
		files: sessionFileStorage(database.connection)
	};
}
it('persists immutable bytes and duplicate names across reopening without entering history reads', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'helia-files-'));
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	const filename = join(directory, 'helia.sqlite');
	const f = await fixture(filename);
	const before = await f.repo.getSessionTimeline(f.game.id, f.scope.sessionId);
	const file = f.files.save(
		f.scope,
		Uint8Array.of(0, 1, 255),
		'같은 이름.bin',
		'application/octet-stream'
	);
	const second = f.files.save(
		f.scope,
		Uint8Array.of(2),
		'같은 이름.bin',
		'application/octet-stream'
	);
	expect(file.ref).not.toBe(second.ref);
	expect(f.files.list(f.scope, { limit: 1 }).nextCursor).not.toBeNull();
	const first = f.files.list(f.scope, { limit: 1 });
	expect(f.files.list(f.scope, { cursor: first.nextCursor!, limit: 1 }).files).toHaveLength(1);
	expect(await f.repo.getSessionTimeline(f.game.id, f.scope.sessionId)).toEqual(before);
	const reopened = openStorage(filename);
	cleanups.push(() => reopened.close());
	expect([...sessionFileStorage(reopened.connection).read(f.scope, file.ref).data]).toEqual([
		0, 1, 255
	]);
	const other = await f.repo.createSession(f.game.id);
	expect(() => f.files.read({ ...f.scope, sessionId: other.id }, file.ref)).toThrow(
		'FILE_NOT_FOUND'
	);
	expect(f.files.list({ ...f.scope, sessionId: other.id }).files).toEqual([]);
});
it('never collects files after checkout or history deletion and permits deleting referenced files', async () => {
	const f = await fixture();
	const file = f.files.save(f.scope, new Uint8Array([1]), 'keep.png', 'image/png');
	await f.repo.commitSessionTransaction(f.game.id, f.scope.sessionId, {
		expectedRevision: 0,
		parentId: null,
		action: { name: 'image', args: {} },
		nextState: { image: file.ref }
	});
	let timeline = await f.repo.getSessionTimeline(f.game.id, f.scope.sessionId);
	const head = timeline.history.progress.headId!;
	await f.repo.appendSessionMessage(f.game.id, f.scope.sessionId, {
		expectedRevision: timeline.history.progress.revision,
		message: { role: 'assistant', content: `![image](${file.ref})` }
	});
	timeline = await f.repo.getSessionTimeline(f.game.id, f.scope.sessionId);
	f.files.remove(f.scope, file.ref);
	expect(() => f.files.read(f.scope, file.ref)).toThrow('FILE_NOT_FOUND');
	expect(await f.repo.getSessionTimeline(f.game.id, f.scope.sessionId)).toEqual(timeline);
	const unused = f.files.save(
		f.scope,
		new Uint8Array([2]),
		'unreferenced.bin',
		'application/octet-stream'
	);
	await f.repo.selectSessionBranch(
		f.game.id,
		f.scope.sessionId,
		null,
		timeline.history.progress.revision
	);
	expect(f.files.stat(f.scope, unused.ref).ref).toBe(unused.ref);
	timeline = await f.repo.getSessionTimeline(f.game.id, f.scope.sessionId);
	await f.repo.deleteSessionEvent(
		f.game.id,
		f.scope.sessionId,
		head,
		timeline.history.progress.revision
	);
	expect(f.files.stat(f.scope, unused.ref).ref).toBe(unused.ref);
	const survivor = await f.repo.createSession(f.game.id);
	await f.repo.selectSession(f.game.id, survivor.id);
	await f.repo.deleteSession(f.game.id, f.scope.sessionId);
	expect(
		f.database.connection.prepare('SELECT count(*) AS count FROM session_files').get()
	).toEqual({ count: 0 });
});
it('rejects invalid writes and quota exhaustion while preserving existing files', async () => {
	const f = await fixture();
	const file = f.files.save(f.scope, new Uint8Array(), 'empty.txt', 'text/plain');
	const text = f.files.save(f.scope, new Uint8Array([65]), 'utf8.txt', 'text/plain;charset=utf-8');
	expect(f.files.read(f.scope, text.ref).info.mime).toBe('text/plain;charset=utf-8');
	f.files.remove(f.scope, text.ref);
	expect(() =>
		f.files.save(
			f.scope,
			new Uint8Array(FILE_LIMITS.fileBytes + 1),
			'large',
			'application/octet-stream'
		)
	).toThrow('FILE_INPUT');
	expect(() => f.files.save(f.scope, new Uint8Array(), 'bad\nname', 'text/plain')).toThrow(
		'FILE_INPUT'
	);
	f.database.connection
		.prepare('UPDATE session_files SET size=? WHERE ref=?')
		.run(FILE_LIMITS.sessionBytes, file.ref);
	expect(() => f.files.save(f.scope, new Uint8Array([1]), 'over-quota', 'text/plain')).toThrow(
		'FILE_QUOTA'
	);
	expect(f.files.list(f.scope).files).toHaveLength(1);
	expect(f.files.read(f.scope, file.ref).data).toHaveLength(0);
});
