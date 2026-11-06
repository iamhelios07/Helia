import { aiError, type AgentEvent } from './protocol.js';
const eventObservers = new Map<string, Set<(event: AgentEvent) => void>>();
const active = new Set<string>();
const observers = new Map<string, Set<() => void>>();
const key = (gameId: string, sessionId: string) => JSON.stringify([gameId, sessionId]);
export const isSessionBusy = (gameId: string, sessionId: string) =>
	active.has(key(gameId, sessionId));
function notify(id: string) {
	for (const observer of observers.get(id) ?? []) {
		try {
			observer();
		} catch {
			/* Observers do not control execution. */
		}
	}
}
export function beginSessionActivity(gameId: string, sessionId: string): () => void {
	const id = key(gameId, sessionId);
	if (active.has(id)) throw aiError('busy');
	active.add(id);
	notify(id);
	let released = false;
	return () => {
		if (!released) {
			released = true;
			active.delete(id);
			notify(id);
		}
	};
}
export function assertSessionIdle(gameId: string, sessionId: string) {
	if (isSessionBusy(gameId, sessionId)) throw aiError('busy');
}
export function publishSessionAIEvent(gameId: string, sessionId: string, event: AgentEvent) {
	for (const observer of eventObservers.get(key(gameId, sessionId)) ?? []) {
		try {
			observer(event);
		} catch {
			/* Presentation cannot change an AI result. */
		}
	}
}
export function subscribeSessionAIEvents(
	gameId: string,
	sessionId: string,
	observer: (event: AgentEvent) => void
): () => void {
	const id = key(gameId, sessionId),
		listeners = eventObservers.get(id) ?? new Set();
	listeners.add(observer);
	eventObservers.set(id, listeners);
	return () => {
		listeners.delete(observer);
		if (!listeners.size) eventObservers.delete(id);
	};
}
export function subscribeSessionActivity(
	gameId: string,
	sessionId: string,
	observer: () => void
): () => void {
	const id = key(gameId, sessionId),
		listeners = observers.get(id) ?? new Set();
	listeners.add(observer);
	observers.set(id, listeners);
	return () => {
		listeners.delete(observer);
		if (!listeners.size) observers.delete(id);
	};
}
