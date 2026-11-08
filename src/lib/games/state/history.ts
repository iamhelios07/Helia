import type { Message, Session } from '#lib/games/model.js';

import { activeTransactions, assertRevision, checkoutHistory } from './engine.js';
import {
	counter,
	identifier,
	type Action,
	type Memory,
	type SessionHistory,
	type StateChange,
	type Transaction
} from './model.js';

export interface HistoryEvent {
	id: string;
	parentId: string | null;
	createdAt: string;
	depth: number;
	active: boolean;
	selected: boolean;
	summary: string;
	action: Action;
	changes: StateChange[];
	message?: Message;
}
export interface SessionTimeline {
	session: Session;
	history: SessionHistory;
	events: HistoryEvent[];
	messages: Message[];
	memories: Memory[];
}
export function transactionSummary(node: Transaction): string {
	if (node.description) {
		return node.description;
	}
	if (!node.changes.length) {
		return node.messageId ? '대화' : `${node.action.name} · 상태 변경 없음`;
	}
	const fields = node.changes.slice(0, 3).map((change) => JSON.stringify(change.path));
	return `${node.action.name} · ${fields.join(', ')}${node.changes.length > 3 ? ` 외 ${node.changes.length - 3}개` : ''}`;
}
/** One event is one atomic transaction, including its optional message. Opening content belongs to the initial state. */
export function historyEvents(
	history: SessionHistory,
	messages: readonly Message[]
): HistoryEvent[] {
	const active = new Set(activeTransactions(history).map((node) => node.id));
	const byMessage = new Map(messages.map((message) => [message.id, message]));
	const children = new Map<string | null, Transaction[]>();
	for (const node of history.transactions) {
		const siblings = children.get(node.parentId) ?? [];
		siblings.push(node);
		children.set(node.parentId, siblings);
	}
	for (const siblings of children.values()) {
		siblings.sort((a, b) => a.createdRevision - b.createdRevision);
	}
	const result: HistoryEvent[] = [];
	const stack = [...(children.get(null) ?? [])].reverse().map((node) => ({ node, depth: 0 }));
	const visited = new Set<string>();
	while (stack.length) {
		const { node, depth } = stack.pop()!;
		if (visited.has(node.id)) {
			throw new Error('진행 기록이 순환하고 있어요.');
		}
		visited.add(node.id);
		const message = historyMessage(node, byMessage);
		result.push({
			id: node.id,
			parentId: node.parentId,
			createdAt: node.createdAt,
			depth,
			active: active.has(node.id),
			selected: history.progress.headId === node.id,
			summary: transactionSummary(node),
			action: node.action,
			changes: node.changes,
			...(message ? { message } : {})
		});
		for (const child of [...(children.get(node.id) ?? [])].reverse()) {
			stack.push({ node: child, depth: depth + 1 });
		}
	}
	if (visited.size !== history.transactions.length) {
		throw new Error('연결되지 않은 진행 기록이 있어요.');
	}
	return result;
}
export function deleteHistoryEvent(
	history: SessionHistory,
	eventId: string,
	expectedRevision: number
): { history: SessionHistory; removedIds: Set<string> } {
	assertRevision(history.progress, expectedRevision);
	identifier(eventId);
	const target = history.transactions.find((node) => node.id === eventId);
	if (!target) {
		throw new Error('삭제할 이벤트를 찾을 수 없어요.');
	}
	// Validate ownership/duplicates and selected path before calculating the subtree.
	activeTransactions(history);
	const children = new Map<string, string[]>();
	for (const node of history.transactions) {
		if (node.parentId !== null) {
			children.set(node.parentId, [...(children.get(node.parentId) ?? []), node.id]);
		}
	}
	const removedIds = new Set<string>();
	const stack = [eventId];
	while (stack.length) {
		const id = stack.pop()!;
		if (removedIds.has(id)) {
			throw new Error('진행 기록이 순환하고 있어요.');
		}
		removedIds.add(id);
		stack.push(...(children.get(id) ?? []));
	}
	const head =
		history.progress.headId !== null && removedIds.has(history.progress.headId)
			? target.parentId
			: history.progress.headId;
	const restored = checkoutHistory(history, head, expectedRevision);
	return {
		history: {
			...history,
			progress: { ...restored, revision: counter(expectedRevision + 1) },
			transactions: history.transactions.filter((node) => !removedIds.has(node.id))
		},
		removedIds
	};
}

function historyMessage(node: Transaction, byMessage: Map<string, Message>): Message | undefined {
	const message = node.messageId ? byMessage.get(node.messageId) : undefined;
	if (node.messageId && !message) {
		throw new Error('이력에 연결된 메시지가 없어요.');
	}
	return message;
}
