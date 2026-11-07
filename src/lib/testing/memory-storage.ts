import {
	CONFLICT,
	parseReply,
	parseRequest,
	type StoredRecord,
	type StorageTransport
} from '#lib/storage/protocol.js';
import { pruneRecords } from '#lib/storage/prune.js';

/** Browser-test transport; persistence behavior is covered separately with real SQLite. */
export function memoryStorage(): StorageTransport {
	let rows = new Map<string, StoredRecord>();
	const versions = new Map<string, number>();
	return async (input) => {
		const request = parseRequest(structuredClone(input));
		if (request.kind === 'prune') {
			const plan = pruneRecords(
				[...rows.values()],
				request.gameId,
				request.sessionId,
				request.eventId,
				request.expectedRevision
			);
			const next = new Map(rows);
			for (const row of plan.deleted) next.delete(`${row.table}:${row.id}`);
			for (const row of plan.updates) next.set(`${row.table}:${row.id}`, row);
			rows = next;
			const version = (versions.get(request.gameId) ?? 0) + 1;
			versions.set(request.gameId, version);
			return parseReply({
				version,
				records: [...rows.values()].filter(
					(row) =>
						row.gameId === request.gameId &&
						(row.table === 'games' ||
							row.table === 'sessions' ||
							row.sessionId === request.sessionId)
				)
			});
		}
		if (request.kind === 'list') {
			return parseReply({
				version: 0,
				records: [...rows.values()].filter((row) => row.table === 'games')
			});
		}
		if (request.kind === 'read') {
			return parseReply({
				version: versions.get(request.gameId) ?? 0,
				records: [...rows.values()].filter(
					(row) =>
						row.gameId === request.gameId &&
						(row.table === 'games' ||
							row.table === 'sessions' ||
							request.includeHistory === true ||
							(request.sessionId !== undefined && row.sessionId === request.sessionId))
				)
			});
		}
		const version = versions.get(request.gameId);
		if (
			(request.kind === 'create' && version !== undefined) ||
			(request.kind === 'commit' && version !== request.version)
		)
			throw new Error(CONFLICT);
		const next = new Map(rows);
		if (request.kind === 'commit') {
			for (const id of request.deleteSessions) {
				for (const [key, row] of next)
					if (row.gameId === request.gameId && row.sessionId === id) next.delete(key);
			}
		}
		for (const row of request.records) {
			const key = `${row.table}:${row.id}`;
			const existing = next.get(key);
			if (
				existing &&
				(existing.gameId !== row.gameId ||
					existing.sessionId !== row.sessionId ||
					['snapshots', 'transactions', 'memories'].includes(row.table))
			)
				throw new Error('Invalid test storage write.');
			next.set(key, row);
		}
		const nextVersion = request.kind === 'create' ? 0 : request.version + 1;
		rows = next;
		versions.set(request.gameId, nextVersion);
		return { version: nextVersion, records: [] };
	};
}
