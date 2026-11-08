import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { hostAILeases } from '#lib/games/ai/leases.js';
import migration from '#lib/storage/migrations/0000_initial.sql?raw';
import {
	CONFLICT,
	parseRequest,
	storedRecord,
	type StoredRecord,
	type StorageReply,
	type StorageRequest,
	type Table
} from '#lib/storage/protocol.js';
import { pruneRecords } from '#lib/storage/prune.js';
import { validateStoredHistory } from '#lib/storage/validate-history.js';

type PruneRequest = Extract<StorageRequest, { kind: 'prune' }>;
type ReadRequest = Extract<StorageRequest, { kind: 'read' }>;
type WriteRequest = Extract<StorageRequest, { kind: 'commit' | 'create' }>;

function readFilter(table: Table, gameId?: string, sessionId?: string) {
	if (gameId === undefined) {
		return sql``;
	}
	if (table === 'games') {
		return sql`where id = ${gameId}`;
	}
	if (sessionId !== undefined && table !== 'sessions') {
		return sql`where game_id = ${gameId} and session_id = ${sessionId}`;
	}
	return sql`where game_id = ${gameId}`;
}
/** One connection owns every read snapshot and every atomic write. No AI work runs here. */
class Storage {
	readonly connection: Database.Database;
	private db: ReturnType<typeof drizzle>;
	constructor(filename: string) {
		if (filename !== ':memory:') {
			mkdirSync(dirname(filename), { recursive: true });
		}
		this.connection = new Database(filename);
		this.connection.pragma('foreign_keys = ON');
		this.connection.pragma('busy_timeout = 5000');
		this.connection.pragma('journal_mode = WAL');
		this.connection.pragma('synchronous = FULL');
		const version = this.connection.pragma('user_version', { simple: true });
		if (version === 0) {
			this.connection.transaction(() => {
				const current = this.connection.pragma('user_version', { simple: true });
				if (current === 0) {
					this.connection.exec(migration);
					this.connection.pragma('user_version = 1');
				} else if (current !== 1) {
					throw new Error('지원하지 않는 DB 버전이에요.');
				}
			})();
		} else if (version !== 1) {
			this.connection.close();
			throw new Error('지원하지 않는 DB 버전이에요.');
		}
		this.db = drizzle(this.connection);
	}
	private readRows(table: Table, gameId?: string, sessionId?: string): StoredRecord[] {
		const filter = readFilter(table, gameId, sessionId);
		const rows = this.db.all<{ value: string; session_id?: string }>(
			sql`select * from ${sql.identifier(table)} ${filter}`
		);
		return rows.map((row) => storedRecord(table, JSON.parse(row.value), row.session_id));
	}
	private writeRow(row: StoredRecord, create: boolean) {
		const table = sql.identifier(row.table);
		const value = JSON.stringify(row.value);
		if (row.table === 'games') {
			if (create) {
				this.db.run(sql`insert into games (id, value) values (${row.id}, ${value})`);
			} else if (
				this.db.run(sql`update games set value = ${value} where id = ${row.id}`).changes !== 1
			) {
				throw new Error('게임을 찾을 수 없어요.');
			}
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
		const result = this.db.run(
			sql`insert into ${table} (${sql.join(
				fields.map((field) => sql.identifier(field)),
				sql`, `
			)}) values (${sql.join(
				values.map((value) => sql`${value}`),
				sql`, `
			)}) ${update}`
		);
		if (result.changes !== 1) {
			throw new Error('다른 세션의 저장 항목이에요.');
		}
	}
	private prune(command: PruneRequest): StorageReply {
		const game = this.db.get<{ version: number }>(
			sql`select version from games where id=${command.gameId}`
		);
		if (!game || game.version >= Number.MAX_SAFE_INTEGER) {
			throw new Error('게임을 찾을 수 없어요.');
		}
		const read = () => [
			...this.readRows('games', command.gameId),
			...this.readRows('sessions', command.gameId),
			...(['messages', 'snapshots', 'progress', 'transactions', 'memories'] as const).flatMap(
				(table) => this.readRows(table, command.gameId, command.sessionId)
			)
		];
		const plan = pruneRecords(read(), command);
		for (const row of plan.deleted) {
			if (
				this.db.run(
					sql`delete from ${sql.identifier(row.table)} where id=${row.id} and game_id=${command.gameId} and session_id=${command.sessionId}`
				).changes !== 1
			) {
				throw new Error('삭제할 기록을 찾을 수 없어요.');
			}
		}
		// Deletion shifts surviving sequence numbers down, so update messages forwards.
		for (const row of plan.updates) {
			if (row.table === 'snapshots') {
				this.db.run(
					sql`update snapshots set value=${JSON.stringify(row.value)} where id=${row.id} and game_id=${command.gameId} and session_id=${command.sessionId}`
				);
			} else {
				this.writeRow(row, false);
			}
		}
		this.db.run(sql`update games set version=version+1 where id=${command.gameId}`);
		const records = read();
		validateStoredHistory(records);
		return { version: game.version + 1, records };
	}
	private read(command: ReadRequest): StorageReply {
		const game = this.db.get<{ version: number }>(
			sql`select version from games where id = ${command.gameId}`
		);
		if (!game) {
			return { version: 0, records: [] };
		}
		const records = [
			...this.readRows('games', command.gameId),
			...this.readRows('sessions', command.gameId)
		];
		if (command.sessionId !== undefined || command.includeHistory) {
			for (const table of [
				'messages',
				'snapshots',
				'progress',
				'transactions',
				'memories'
			] as const) {
				records.push(...this.readRows(table, command.gameId, command.sessionId));
			}
		}
		validateStoredHistory(records);
		return { version: game.version, records };
	}
	private commitVersion(command: Extract<StorageRequest, { kind: 'commit' }>) {
		if (
			this.db.run(
				sql`update games set version = version + 1 where id = ${command.gameId} and version = ${command.version} and version < 9007199254740991`
			).changes !== 1
		) {
			throw new Error(CONFLICT);
		}
		for (const id of command.deleteSessions) {
			if (
				this.db.run(sql`delete from sessions where id = ${id} and game_id = ${command.gameId}`)
					.changes !== 1
			) {
				throw new Error('세션을 찾을 수 없어요.');
			}
		}
	}
	private validateActiveSession(command: WriteRequest) {
		const game = this.db.get<{ value: string }>(
			sql`select value from games where id = ${command.gameId}`
		);
		if (!game) {
			throw new Error('게임을 찾을 수 없어요.');
		}
		const activeId = (JSON.parse(game.value) as { activeSessionId: string }).activeSessionId;
		if (
			!this.db.get(
				sql`select id from sessions where id = ${activeId} and game_id = ${command.gameId}`
			)
		) {
			throw new Error('선택된 세션을 찾을 수 없어요.');
		}
	}
	private write(command: WriteRequest): StorageReply {
		if (command.kind === 'commit') {
			this.commitVersion(command);
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
					? (b.value as { sequence: number }).sequence - (a.value as { sequence: number }).sequence
					: 0)
		);
		for (const row of records) {
			this.writeRow(row, command.kind === 'create');
		}
		for (const sessionId of new Set(
			records
				.filter((row) => row.table !== 'games' && row.table !== 'sessions')
				.map((row) => row.sessionId!)
		)) {
			validateStoredHistory(
				(
					['sessions', 'messages', 'snapshots', 'progress', 'transactions', 'memories'] as const
				).flatMap((table) => this.readRows(table, command.gameId, sessionId))
			);
		}
		this.validateActiveSession(command);
		return { version: command.kind === 'create' ? 0 : command.version + 1, records: [] };
	}
	private execute(command: StorageRequest): StorageReply {
		if (command.kind === 'prune') {
			return this.prune(command);
		}
		if (command.kind === 'list') {
			return { version: 0, records: this.readRows('games') };
		}
		if (command.kind === 'read') {
			return this.read(command);
		}
		return this.write(command);
	}
	request = (input: unknown): StorageReply => {
		const command = parseRequest(input);
		hostAILeases.guard(command);
		return this.db.transaction(() => this.execute(command), {
			behavior: command.kind === 'read' || command.kind === 'list' ? 'deferred' : 'immediate'
		});
	};
	close = () => this.connection.close();
}
export function openStorage(filename: string) {
	return new Storage(filename);
}

let storage: ReturnType<typeof openStorage> | undefined;
export function serverStorage() {
	return (storage ??= openStorage(resolve(process.env.HELIA_DATA_DIR ?? 'data', 'helia.sqlite')));
}
