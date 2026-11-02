import { sameValue, type GameState } from './value.js';
import { applyChanges } from './changes.js';
export { diffState, applyChanges } from './changes.js';
import { validateState } from './schema.js';
import { createWorkspace, type TransactionValidator } from './workspace.js';
import {
	counter,
	parseAction,
	parseTransaction,
	type GameSnapshot,
	type Transaction,
	type SessionState,
	type Memory,
	type SessionHistory,
	type Action
} from './model.js';

export interface CommitTransaction {
	expectedRevision: number;
	/** Explicit parent also supports making a new response from an earlier checkpoint. */
	parentId: string | null;
	nextState: GameState;
	action: Action;
	description?: string;
}

export function activeTransactions(
	history: SessionHistory,
	headId = history.progress.headId
): Transaction[] {
	const nodes = new Map<string, Transaction>();
	for (const node of history.transactions) {
		if (
			node.gameId !== history.progress.gameId ||
			node.sessionId !== history.progress.sessionId ||
			nodes.has(node.id)
		)
			throw new Error('다른 세션의 기록이 섞여 있어요.');
		nodes.set(node.id, node);
	}
	const visited = new Set<string>();
	const path: Transaction[] = [];
	while (headId !== null) {
		if (visited.has(headId)) throw new Error('진행 기록이 순환하고 있어요.');
		visited.add(headId);
		const node = nodes.get(headId);
		if (!node) throw new Error('진행 기록을 찾을 수 없어요.');
		path.push(node);
		headId = node.parentId;
	}
	return path.reverse();
}

export function stateAt(history: SessionHistory, headId = history.progress.headId): GameState {
	if (
		history.snapshot.id !== history.progress.snapshotId ||
		history.snapshot.gameId !== history.progress.gameId
	)
		throw new Error('세션의 게임 정의가 일치하지 않아요.');
	let state = validateState(history.snapshot.schema, history.snapshot.initialState, 'load');
	let revision = 0;
	for (const transaction of activeTransactions(history, headId)) {
		if (
			transaction.createdRevision <= revision ||
			transaction.createdRevision > history.progress.revision
		)
			throw new Error('게임 진행 리비전이 올바르지 않아요.');
		revision = transaction.createdRevision;
		state = validateState(
			history.snapshot.schema,
			applyChanges(state, transaction.changes),
			'load'
		);
	}
	return state;
}

export function createSessionState(snapshot: GameSnapshot, sessionId: string): SessionState {
	return {
		schemaVersion: 2,
		sessionId,
		gameId: snapshot.gameId,
		snapshotId: snapshot.id,
		headId: null,
		revision: 0,
		state: validateState(snapshot.schema, snapshot.initialState, 'initial')
	};
}

export function assertRevision(progress: SessionState, expected: number) {
	if (progress.revision !== counter(expected))
		throw new Error('게임 상태가 변경되었어요. 최신 상태에서 다시 시도해주세요.');
}

function nextRevision(progress: SessionState): number {
	return counter(progress.revision + 1);
}

export function prepareTransaction(
	history: SessionHistory,
	input: CommitTransaction,
	metadata: { id: string; createdAt: string; messageId?: string },
	validate?: TransactionValidator
): { progress: SessionState; transaction: Transaction } {
	assertRevision(history.progress, input.expectedRevision);
	const before = stateAt(history, input.parentId);
	const restored = stateAt(history);
	if (!sameValue(restored, validateState(history.snapshot.schema, history.progress.state, 'load')))
		throw new Error('Stored progress does not match history.');
	const workspace = createWorkspace(history.snapshot.schema, before);
	workspace.replace(input.nextState);
	const { state: after, changes } = workspace.finish(input.action, validate);
	const revision = nextRevision(history.progress);
	const transaction = parseTransaction({
		schemaVersion: 2,
		id: metadata.id,
		gameId: history.progress.gameId,
		sessionId: history.progress.sessionId,
		parentId: input.parentId,
		createdAt: metadata.createdAt,
		createdRevision: revision,
		action: parseAction(input.action),
		changes,
		...(input.description === undefined ? {} : { description: input.description }),
		...(metadata.messageId === undefined ? {} : { messageId: metadata.messageId })
	});
	if (history.transactions.some((node) => node.id === transaction.id))
		throw new Error('이미 존재하는 트랜잭션이에요.');
	return {
		progress: { ...history.progress, headId: transaction.id, revision, state: after },
		transaction
	};
}

export function checkoutHistory(
	history: SessionHistory,
	headId: string | null,
	expectedRevision: number
): SessionState {
	assertRevision(history.progress, expectedRevision);
	const state = stateAt(history, headId);
	return {
		...history.progress,
		headId,
		state,
		revision:
			headId === history.progress.headId
				? history.progress.revision
				: nextRevision(history.progress)
	};
}

export function messageBase(
	history: SessionHistory,
	transactionId: string
): { headId: string | null; state: GameState } {
	const node = activeTransactions(history).find((node) => node.id === transactionId);
	if (!node?.messageId) throw new Error('현재 진행 경로의 메시지 기록을 찾을 수 없어요.');
	return { headId: node.parentId, state: stateAt(history, node.parentId) };
}

export function activeMemories(history: SessionHistory, memories: readonly Memory[]): Memory[] {
	const ids = new Set(activeTransactions(history).map((node) => node.id));
	return memories.filter(
		(memory) =>
			memory.gameId === history.progress.gameId &&
			memory.sessionId === history.progress.sessionId &&
			memory.sourceTransactionIds.length > 0 &&
			memory.sourceTransactionIds.every((id) => ids.has(id))
	);
}
