import { deleteHistoryEvent } from '#lib/games/state/history.js';
import {
	parseGameSnapshot,
	parseSessionState,
	parseTransaction,
	parseMemory
} from '#lib/games/state/model.js';
import { parseGame, parseSession, parseMessage } from '#lib/games/model.js';
import { storedRecord, type StoredRecord } from './protocol.js';
import { validateStoredHistory } from './validate-history.js';

/** Pure deletion plan. Both deletions and replacement rows must be published in one host transaction. */
export function pruneRecords(
	records: readonly StoredRecord[],
	gameId: string,
	sessionId: string,
	eventId: string,
	revision: number
) {
	validateStoredHistory(records);
	const game = parseGame(records.find((row) => row.table === 'games' && row.id === gameId)?.value);
	const owned = records.filter((row) => row.gameId === gameId && row.sessionId === sessionId);
	const session = parseSession(owned.find((row) => row.table === 'sessions')?.value);
	const progress = parseSessionState(owned.find((row) => row.table === 'progress')?.value);
	const snapshot = parseGameSnapshot(
		owned.find((row) => row.table === 'snapshots' && row.id === progress.snapshotId)?.value
	);
	const transactions = owned
		.filter((row) => row.table === 'transactions')
		.map((row) => parseTransaction(row.value));
	const { history, removedIds } = deleteHistoryEvent(
		{ snapshot, progress, transactions },
		eventId,
		revision
	);
	const removedMessages = new Set(
		transactions
			.filter((node) => removedIds.has(node.id))
			.flatMap((node) => (node.messageId ? [node.messageId] : []))
	);
	const deleted = owned.filter(
		(row) =>
			(row.table === 'transactions' && removedIds.has(row.id)) ||
			(row.table === 'messages' && removedMessages.has(row.id)) ||
			(row.table === 'memories' &&
				parseMemory(row.value).sourceTransactionIds.some((id) => removedIds.has(id)))
	);
	const messages = owned
		.filter((row) => row.table === 'messages' && !removedMessages.has(row.id))
		.map((row) => parseMessage(row.value))
		.sort((a, b) => a.sequence - b.sequence)
		.map((message, index) => ({ ...message, sequence: index + 1 }));
	const now = new Date().toISOString();
	const updates = [
		storedRecord('games', { ...game, updatedAt: now }),
		storedRecord('sessions', { ...session, messageCount: messages.length, updatedAt: now }),
		storedRecord('progress', history.progress),
		...messages.map((message) => storedRecord('messages', message)),
		...owned
			.filter((row) => row.table === 'snapshots')
			.flatMap((row) => {
				const snapshot = parseGameSnapshot(row.value);
				if (
					!snapshot.restoredStates ||
					!Object.keys(snapshot.restoredStates).some((id) => removedIds.has(id))
				)
					return [];
				return [
					storedRecord(
						'snapshots',
						{
							...snapshot,
							restoredStates: Object.fromEntries(
								Object.entries(snapshot.restoredStates).filter(([id]) => !removedIds.has(id))
							)
						},
						sessionId
					)
				];
			})
	];
	return { deleted, updates };
}
