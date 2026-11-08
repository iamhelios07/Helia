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

class MemoryStorage {
	private rows = new Map<string, StoredRecord>();
	private versions = new Map<string, number>();
	private prune(request: Extract<StorageRequest, { kind: 'prune' }>) {
		const plan = pruneRecords([...this.rows.values()], request);
		const next = new Map(this.rows);
		for (const row of plan.deleted) {
			next.delete(`${row.table}:${row.id}`);
		}
		for (const row of plan.updates) {
			next.set(`${row.table}:${row.id}`, row);
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
	private list() {
		return parseReply({
			version: 0,
			records: [...this.rows.values()].filter((row) => row.table === 'games')
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
	private write(request: Extract<StorageRequest, { kind: 'commit' | 'create' }>): StorageReply {
		const version = this.versions.get(request.gameId);
		if (
			(request.kind === 'create' && version !== undefined) ||
			(request.kind === 'commit' && version !== request.version)
		) {
			throw new Error(CONFLICT);
		}
		const next = new Map(this.rows);
		if (request.kind === 'commit') {
			this.deleteSessions(next, request);
		}
		for (const row of request.records) {
			const key = `${row.table}:${row.id}`;
			const existing = next.get(key);
			if (
				existing &&
				(existing.gameId !== row.gameId ||
					existing.sessionId !== row.sessionId ||
					['snapshots', 'transactions', 'memories'].includes(row.table))
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
			return this.list();
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
