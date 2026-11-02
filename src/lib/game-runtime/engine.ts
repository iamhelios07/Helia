import {
	parseGameState,
	parseStateValue,
	isStateObject,
	sameValue,
	validateStateKey,
	type GameState
} from './value.js';
import {
	counter,
	parseAction,
	parseTransaction,
	type GameSnapshot,
	type Transaction,
	type SessionState,
	type Memory,
	type SessionHistory,
	type StateChange,
	type StateSlot,
	type Action
} from './model.js';

export interface CommitTransaction {
	expectedRevision: number;
	/** Explicit parent also supports making a new response from an earlier checkpoint. */
	parentId: string | null;
	nextState: GameState;
	action: Action;
}

function slot(state: GameState, key: string): StateSlot {
	return Object.hasOwn(state, key) ? { exists: true, value: state[key] } : { exists: false };
}
function sameSlot(first: StateSlot, second: StateSlot): boolean {
	return (
		first.exists === second.exists &&
		(!first.exists || (second.exists && sameValue(first.value, second.value)))
	);
}

/** Arrays are recorded as values; insertion/removal cannot invalidate later index paths. */
export function diffState(
	before: GameState,
	after: GameState,
	prefix: string[] = []
): StateChange[] {
	const result: StateChange[] = [];
	for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
		const old = slot(before, key);
		const next = slot(after, key);
		if (sameSlot(old, next)) continue;
		const path = [...prefix, key];
		if (old.exists && next.exists && isStateObject(old.value) && isStateObject(next.value))
			result.push(...diffState(old.value, next.value, path));
		else result.push({ path, before: old, after: next });
	}
	return result;
}

export function applyChanges(state: GameState, changes: readonly StateChange[]): GameState {
	const next = parseGameState(state);
	for (const change of changes) {
		if (!change.path.length) throw new Error('상태 변경 경로가 올바르지 않아요.');
		change.path.forEach(validateStateKey);
		let parent = next;
		for (const key of change.path.slice(0, -1)) {
			if (!Object.hasOwn(parent, key) || !isStateObject(parent[key]))
				throw new Error('상태 변경 경로를 복원할 수 없어요.');
			parent = parent[key] as GameState;
		}
		const key = change.path.at(-1)!;
		if (!sameSlot(slot(parent, key), change.before))
			throw new Error('상태 변경 전 값이 기록과 일치하지 않아요.');
		if (change.after.exists) parent[key] = parseStateValue(change.after.value);
		else delete parent[key];
	}
	return next;
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
	let state = parseGameState(history.snapshot.initialState);
	for (const transaction of activeTransactions(history, headId))
		state = applyChanges(state, transaction.changes);
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
		state: parseGameState(snapshot.initialState)
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
	metadata: { id: string; createdAt: string; messageId?: string }
): { progress: SessionState; transaction: Transaction } {
	assertRevision(history.progress, input.expectedRevision);
	const before = stateAt(history, input.parentId);
	const after = parseGameState(input.nextState);
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
		changes: diffState(before, after),
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
