import { stateAt } from '#lib/game-runtime/engine.js';
import { parseGameSnapshot, parseSessionState, parseTransaction } from '#lib/game-runtime/model.js';
import { validateState } from '#lib/game-runtime/schema.js';
import { sameValue } from '#lib/game-runtime/value.js';
import type { StoredRecord } from './protocol.js';

/** Validate the resulting records inside the host's write transaction, including inactive branches. */
export function validateStoredHistory(records: readonly StoredRecord[]): void {
	const sessions = new Set(
		records
			.filter(
				(row) =>
					row.table === 'progress' || row.table === 'transactions' || row.table === 'snapshots'
			)
			.map((row) => row.sessionId)
	);
	for (const sessionId of sessions) {
		const owned = records.filter((row) => row.sessionId === sessionId);
		const progress = parseSessionState(owned.find((row) => row.table === 'progress')?.value);
		const snapshot = parseGameSnapshot(
			owned.find((row) => row.table === 'snapshots' && row.id === progress.snapshotId)?.value
		);
		const transactions = owned
			.filter((row) => row.table === 'transactions')
			.map((row) => parseTransaction(row.value));
		const history = { snapshot, progress, transactions };
		const revisions = new Set<number>();
		for (const node of transactions) {
			if (
				!node.createdRevision ||
				node.createdRevision > progress.revision ||
				revisions.has(node.createdRevision)
			)
				throw new Error('게임 진행 리비전이 올바르지 않아요.');
			revisions.add(node.createdRevision);
			stateAt(history, node.id);
		}
		if (!sameValue(stateAt(history), validateState(snapshot.schema, progress.state, 'load')))
			throw new Error('저장된 상태가 진행 기록과 일치하지 않아요.');
	}
}
