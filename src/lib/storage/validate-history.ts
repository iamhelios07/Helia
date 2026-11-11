import { parseMessage, parseSession } from '#lib/games/model.js';
import { stateAt } from '#lib/games/state/engine.js';
import {
	parseGameSnapshot,
	parseSessionState,
	parseSnapshotCheckpoint,
	parseTransaction,
	parseMemory,
	type SessionHistory,
	type Transaction
} from '#lib/games/state/model.js';
import { validateState } from '#lib/games/state/schema.js';
import { sameValue } from '#lib/games/state/value.js';

import type { StoredRecord } from './protocol.js';

/** Validate the resulting records inside the host's write transaction, including inactive branches. */
export function validateStoredHistory(records: readonly StoredRecord[]): void {
	const sessions = new Set(
		records
			.filter((row) => row.table === 'progress' || row.table === 'transactions')
			.map((row) => row.sessionId)
	);
	for (const sessionId of sessions) {
		const owned = records.filter((row) => row.sessionId === sessionId || row.table === 'snapshots');
		const progress = parseSessionState(owned.find((row) => row.table === 'progress')?.value);
		const snapshot = parseGameSnapshot(
			records.find(
				(row) =>
					row.table === 'snapshots' &&
					row.id === progress.snapshotId &&
					row.gameId === progress.gameId
			)?.value
		);
		const transactions = owned
			.filter((row) => row.table === 'transactions')
			.map((row) => parseTransaction(row.value));
		const history: SessionHistory = {
			snapshot,
			progress,
			transactions,
			checkpoints: owned
				.filter((row) => row.table === 'checkpoints')
				.map((row) => parseSnapshotCheckpoint(row.value)),
			resources: {}
		};
		validateRestoredStates(history, owned);
		validateMessages(owned, transactions);
		validateMemories(owned, transactions);
		validateRevisions(history);
	}
}

function validateRestoredStates(history: SessionHistory, owned: readonly StoredRecord[]) {
	for (const checkpoint of history.checkpoints) {
		if (
			checkpoint.snapshotId !== history.snapshot.id ||
			checkpoint.gameId !== history.progress.gameId
		) {
			continue;
		}
		if (!history.transactions.some((node) => node.id === checkpoint.transactionId)) {
			throw Error('상태 변환의 기록을 찾을 수 없어요.');
		}
		if (!owned.some((row) => row.table === 'checkpoints' && row.id === checkpoint.transactionId)) {
			throw Error('상태 변환의 원본을 찾을 수 없어요.');
		}
		validateState(history.snapshot.schema, checkpoint.state, 'load');
	}
}
function validateMessages(owned: readonly StoredRecord[], transactions: readonly Transaction[]) {
	const messageRows = owned.filter((row) => row.table === 'messages');
	const sessionRow = owned.find((row) => row.table === 'sessions');
	if (!sessionRow) {
		return;
	}
	const session = parseSession(sessionRow.value);
	const messages = messageRows
		.map((row) => parseMessage(row.value))
		.sort((a, b) => a.sequence - b.sequence);
	if (
		messages.length !== (session.messageCount ?? 0) ||
		messages.some((message, index) => message.sequence !== index + 1)
	) {
		throw new Error('저장된 메시지 순서가 올바르지 않아요.');
	}
	const messageIds = new Set(messages.map((message) => message.id));
	const linked = transactions.flatMap((node) => (node.messageId ? [node.messageId] : []));
	if (
		new Set(linked).size !== linked.length ||
		linked.some((id) => !messageIds.has(id)) ||
		messages.some((message) => message.kind !== 'opening' && !linked.includes(message.id))
	) {
		throw new Error('메시지와 이력 연결이 올바르지 않아요.');
	}
}
function validateMemories(owned: readonly StoredRecord[], transactions: readonly Transaction[]) {
	const ids = new Set(transactions.map((node) => node.id));
	for (const row of owned.filter((row) => row.table === 'memories')) {
		if (parseMemory(row.value).sourceTransactionIds.some((id) => !ids.has(id))) {
			throw new Error('기억의 출처 기록을 찾을 수 없어요.');
		}
	}
}
function validateRevisions(history: SessionHistory) {
	const { progress, snapshot, transactions } = history;
	const revisions = new Set<number>();
	for (const node of transactions) {
		if (
			!node.createdRevision ||
			node.createdRevision > progress.revision ||
			revisions.has(node.createdRevision)
		) {
			throw new Error('게임 진행 리비전이 올바르지 않아요.');
		}
		revisions.add(node.createdRevision);
		stateAt(history, node.id);
	}
	if (!sameValue(stateAt(history), validateState(snapshot.schema, progress.state, 'load'))) {
		throw new Error('저장된 상태가 진행 기록과 일치하지 않아요.');
	}
}
