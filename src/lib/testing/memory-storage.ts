import {
	CONFLICT,
	parseReply,
	parseRequest,
	type StoredRecord,
	type StorageRequest,
	type StorageReply,
	type StorageTransport
} from '#lib/storage/protocol.js';
import { pruneRecords } from '#lib/storage/prune.js';

/** Rows are keyed by table + game + id: shared content rows collide across games otherwise. */
function keyOf(row: StoredRecord): string {
	return `${row.table}:${row.gameId}:${row.id}`;
}

class MemoryStorage {
	private rows = new Map<string, StoredRecord>();
	private versions = new Map<string, number>();
	private prune(request: Extract<StorageRequest, { kind: 'prune' }>) {
		const plan = pruneRecords([...this.rows.values()], request);
		const next = new Map(this.rows);
		for (const row of plan.deleted) {
			next.delete(keyOf(row));
		}
		for (const row of plan.updates) {
			next.set(keyOf(row), row);
		}
		this.rows = next;
		const version = (this.versions.get(request.gameId) ?? 0) + 1;
		this.versions.set(request.gameId, version);
		return parseReply({
			version,
			records: [...this.rows.values()].filter(
				(row) =>
					row.gameId === request.gameId &&
					(row.table === 'games' || row.table === 'sessions' || row.sessionId === request.sessionId)
			)
		});
	}
	private list(includeTrashed = false) {
		return parseReply({
			version: 0,
			records: [...this.rows.values()].filter(
				(row) =>
					row.table === 'games' &&
					(includeTrashed || (row.value as { trashedAt?: string }).trashedAt === undefined)
			)
		});
	}
	private read(request: Extract<StorageRequest, { kind: 'read' }>) {
		return parseReply({
			version: this.versions.get(request.gameId) ?? 0,
			records: [...this.rows.values()].filter(
				(row) =>
					row.gameId === request.gameId &&
					(row.table === 'games' ||
						row.table === 'sessions' ||
						row.sessionId === null ||
						request.includeHistory === true ||
						(request.sessionId !== undefined && row.sessionId === request.sessionId))
			)
		});
	}
	private deleteSessions(
		next: Map<string, StoredRecord>,
		request: Extract<StorageRequest, { kind: 'commit' }>
	) {
		for (const id of request.deleteSessions) {
			for (const [key, row] of next) {
				if (row.gameId === request.gameId && row.sessionId === id) {
					next.delete(key);
				}
			}
		}
	}
	private trashedAt(gameId: string): string | undefined {
		return (this.rows.get('games:' + gameId)?.value as { trashedAt?: string } | undefined)
			?.trashedAt;
	}
	private trash(request: Extract<StorageRequest, { kind: 'trash' | 'restore' }>): StorageReply {
		const row = this.rows.get('games:' + request.gameId);
		if (!row) {
			throw new Error('게임을 찾을 수 없어요.');
		}
		const value = {
			...(row.value as Record<string, unknown>),
			trashedAt: request.kind === 'trash' ? new Date().toISOString() : null
		};
		const updated = { ...row, value };
		this.rows.set('games:' + request.gameId, updated);
		return { version: this.versions.get(request.gameId) ?? 0, records: [updated] };
	}
	private purge(request: Extract<StorageRequest, { kind: 'purge' }>): StorageReply {
		const row = this.rows.get('games:' + request.gameId);
		if (!row) {
			throw new Error('게임을 찾을 수 없어요.');
		}
		if (this.trashedAt(request.gameId) === undefined) {
			throw new Error('휴지통에 있는 게임만 삭제할 수 있어요.');
		}
		const next = new Map(this.rows);
		for (const [key, gameRow] of next) {
			if (gameRow.gameId === request.gameId) {
				next.delete(key);
			}
		}
		this.rows = next;
		return { version: this.versions.get(request.gameId) ?? 0, records: [] };
	}
	private write(request: Extract<StorageRequest, { kind: 'commit' | 'create' }>): StorageReply {
		const version = this.versions.get(request.gameId);
		if (
			(request.kind === 'create' && version !== undefined) ||
			(request.kind === 'commit' && version !== request.version)
		) {
			throw new Error(CONFLICT);
		}
		if (this.trashedAt(request.gameId) !== undefined) {
			throw new Error('휴지통에 있는 게임은 변경할 수 없어요.');
		}
		const next = new Map(this.rows);
		if (request.kind === 'commit') {
			this.deleteSessions(next, request);
		}
		for (const row of request.records) {
			const key = keyOf(row);
			const existing = next.get(key);
			if (
				existing &&
				(existing.gameId !== row.gameId ||
					existing.sessionId !== row.sessionId ||
					['transactions', 'memories'].includes(row.table))
			) {
				throw new Error('Invalid test storage write.');
			}
			next.set(key, row);
		}
		const nextVersion = request.kind === 'create' ? 0 : request.version + 1;
		this.rows = next;
		this.versions.set(request.gameId, nextVersion);
		return { version: nextVersion, records: [] };
	}
	request = async (input: unknown): Promise<StorageReply> => {
		const request = parseRequest(structuredClone(input));
		if (request.kind === 'prune') {
			return this.prune(request);
		}
		if (request.kind === 'list') {
			return this.list(request.includeTrashed === true);
		}
		if (request.kind === 'trash' || request.kind === 'restore') {
			return this.trash(request);
		}
		if (request.kind === 'purge') {
			return this.purge(request);
		}
		if (request.kind === 'read') {
			return this.read(request);
		}
		return this.write(request);
	};
}
/** Browser-test transport; persistence behavior is covered separately with real SQLite. */
export function memoryStorage(): StorageTransport {
	return new MemoryStorage().request;
}
