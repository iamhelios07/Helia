import { stateAt } from '#lib/game-runtime/engine.js';
import {
	parseGameSnapshot,
	parseSessionState,
	parseTransaction,
	parseMemory
} from '#lib/game-runtime/model.js';
import { parseMessage, parseSession } from '#lib/games/model.js';
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
		const messageRows = owned.filter((row) => row.table === 'messages');
		const sessionRow = owned.find((row) => row.table === 'sessions');
		if (sessionRow) {
			const session = parseSession(sessionRow.value);
			const messages = messageRows
				.map((row) => parseMessage(row.value))
				.sort((a, b) => a.sequence - b.sequence);
			if (
				messages.length !== (session.messageCount ?? 0) ||
				messages.some((message, index) => message.sequence !== index + 1)
			)
				throw new Error('저장된 메시지 순서가 올바르지 않아요.');
			const messageIds = new Set(messages.map((message) => message.id));
			const linked = transactions.flatMap((node) => (node.messageId ? [node.messageId] : []));
			if (
				new Set(linked).size !== linked.length ||
				linked.some((id) => !messageIds.has(id)) ||
				messages.some((message) => message.kind !== 'opening' && !linked.includes(message.id))
			)
				throw new Error('메시지와 이력 연결이 올바르지 않아요.');
		}
		const ids = new Set(transactions.map((node) => node.id));
		for (const row of owned.filter((row) => row.table === 'memories'))
			if (parseMemory(row.value).sourceTransactionIds.some((id) => !ids.has(id)))
				throw new Error('기억의 출처 기록을 찾을 수 없어요.');
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
