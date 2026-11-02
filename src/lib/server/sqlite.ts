import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import migration from '#lib/storage/migrations/0000_initial.sql?raw';
import { validateStoredHistory } from '#lib/storage/validate-history.js';
import {
	CONFLICT,
	parseRequest,
	storedRecord,
	type StoredRecord,
	type StorageReply,
	type Table
} from '#lib/storage/protocol.js';

/** One connection owns every read snapshot and every atomic write. No AI work runs here. */
export function openStorage(filename: string) {
	if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
	const connection = new Database(filename);
	connection.pragma('foreign_keys = ON');
	connection.pragma('busy_timeout = 5000');
	connection.pragma('journal_mode = WAL');
	connection.pragma('synchronous = FULL');
	const version = connection.pragma('user_version', { simple: true });
	if (version === 0)
		connection.transaction(() => {
			const current = connection.pragma('user_version', { simple: true });
			if (current === 0) {
				connection.exec(migration);
				connection.pragma('user_version = 1');
			} else if (current !== 1) throw new Error('지원하지 않는 DB 버전이에요.');
		})();
	else if (version !== 1) {
		connection.close();
		throw new Error('지원하지 않는 DB 버전이에요.');
	}
	const db = drizzle(connection);

	function readRows(table: Table, gameId?: string, sessionId?: string): StoredRecord[] {
		const filter =
			gameId === undefined
				? sql``
				: table === 'games'
					? sql`where id = ${gameId}`
					: sessionId !== undefined && table !== 'sessions'
						? sql`where game_id = ${gameId} and session_id = ${sessionId}`
						: sql`where game_id = ${gameId}`;
		const rows = db.all<{ value: string; session_id?: string }>(
			sql`select * from ${sql.identifier(table)} ${filter}`
		);
		return rows.map((row) => storedRecord(table, JSON.parse(row.value), row.session_id));
	}

	function writeRow(row: StoredRecord, create: boolean) {
		const table = sql.identifier(row.table);
		const value = JSON.stringify(row.value);
		if (row.table === 'games') {
			if (create) db.run(sql`insert into games (id, value) values (${row.id}, ${value})`);
			else if (db.run(sql`update games set value = ${value} where id = ${row.id}`).changes !== 1)
				throw new Error('게임을 찾을 수 없어요.');
			return;
		}
		const fields = ['id', 'game_id', ...(row.table === 'sessions' ? [] : ['session_id']), 'value'];
		const values: (string | number | null)[] = [
			row.id,
			row.gameId,
			...(row.table === 'sessions' ? [] : [row.sessionId]),
			value
		];
		const object = row.value as Record<string, unknown>;
		if (row.table === 'messages') {
			fields.push('sequence');
			values.push(object.sequence as number);
		}
		if (row.table === 'progress') {
			fields.push('snapshot_id');
			values.push(object.snapshotId as string);
		}
		const immutable = ['snapshots', 'transactions', 'memories'].includes(row.table);
		const ownership =
			row.table === 'sessions'
				? sql`${table}.game_id = excluded.game_id`
				: sql`${table}.game_id = excluded.game_id and ${table}.session_id = excluded.session_id`;
		const update =
			immutable || create
				? sql``
				: sql`on conflict(id) do update set ${sql.join(
						fields
							.filter((field) => !['id', 'game_id', 'session_id'].includes(field))
							.map((field) => sql`${sql.identifier(field)} = excluded.${sql.identifier(field)}`),
						sql`, `
					)} where ${ownership}`;
		const result = db.run(
			sql`insert into ${table} (${sql.join(
				fields.map((field) => sql.identifier(field)),
				sql`, `
			)}) values (${sql.join(
				values.map((value) => sql`${value}`),
				sql`, `
			)}) ${update}`
		);
		if (result.changes !== 1) throw new Error('다른 세션의 저장 항목이에요.');
	}

	function request(input: unknown): StorageReply {
		const command = parseRequest(input);
		return db.transaction(
			() => {
				if (command.kind === 'list') return { version: 0, records: readRows('games') };
				if (command.kind === 'read') {
					const game = db.get<{ version: number }>(
						sql`select version from games where id = ${command.gameId}`
					);
					if (!game) return { version: 0, records: [] };
					const records = [
						...readRows('games', command.gameId),
						...readRows('sessions', command.gameId)
					];
					if (command.sessionId !== undefined) {
						for (const table of [
							'messages',
							'snapshots',
							'progress',
							'transactions',
							'memories'
						] as const)
							records.push(...readRows(table, command.gameId, command.sessionId));
					}
					validateStoredHistory(records);
					return { version: game.version, records };
				}
				if (command.kind === 'commit') {
					if (
						db.run(
							sql`update games set version = version + 1 where id = ${command.gameId} and version = ${command.version} and version < 9007199254740991`
						).changes !== 1
					)
						throw new Error(CONFLICT);
					for (const id of command.deleteSessions) {
						if (
							db.run(sql`delete from sessions where id = ${id} and game_id = ${command.gameId}`)
								.changes !== 1
						)
							throw new Error('세션을 찾을 수 없어요.');
					}
				}
				// Parents precede children; shifted message sequence values are updated backwards.
				const order = [
					'games',
					'sessions',
					'snapshots',
					'messages',
					'progress',
					'transactions',
					'memories'
				];
				const records = [...command.records].sort(
					(a, b) =>
						order.indexOf(a.table) - order.indexOf(b.table) ||
						(a.table === 'messages'
							? (b.value as { sequence: number }).sequence -
								(a.value as { sequence: number }).sequence
							: 0)
				);
				for (const row of records) writeRow(row, command.kind === 'create');
				for (const sessionId of new Set(
					records
						.filter((row) => row.table !== 'games' && row.table !== 'sessions')
						.map((row) => row.sessionId!)
				)) {
					validateStoredHistory(
						(['snapshots', 'progress', 'transactions'] as const).flatMap((table) =>
							readRows(table, command.gameId, sessionId)
						)
					);
				}
				const game = db.get<{ value: string }>(
					sql`select value from games where id = ${command.gameId}`
				);
				if (!game) throw new Error('게임을 찾을 수 없어요.');
				const activeId = (JSON.parse(game.value) as { activeSessionId: string }).activeSessionId;
				if (
					!db.get(
						sql`select id from sessions where id = ${activeId} and game_id = ${command.gameId}`
					)
				)
					throw new Error('선택된 세션을 찾을 수 없어요.');
				return { version: command.kind === 'create' ? 0 : command.version + 1, records: [] };
			},
			{ behavior: command.kind === 'read' || command.kind === 'list' ? 'deferred' : 'immediate' }
		);
	}
	return { request, close: () => connection.close(), connection };
}

let storage: ReturnType<typeof openStorage> | undefined;
export function serverStorage() {
	return (storage ??= openStorage(resolve(process.env.HELIA_DATA_DIR ?? 'data', 'helia.sqlite')));
}
