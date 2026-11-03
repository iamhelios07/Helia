import { identifier } from '#lib/games/state/model.js';
import type { UIEvent } from './protocol.js';

export interface SessionUIEvent extends UIEvent {
	gameId: string;
	sessionId: string;
	transactionId: string;
}
export type UIEventListener = (event: Readonly<SessionUIEvent>) => void;
function freeze<T>(value: T): T {
	if (value !== null && typeof value === 'object') {
		Object.values(value).forEach(freeze);
		Object.freeze(value);
	}
	return value;
}
/** Ephemeral UI delivery. Replaying history never publishes these events again. */
export function createSessionEvents() {
	const listeners = new Map<string, Set<UIEventListener>>();
	const key = (gameId: string, sessionId: string) =>
		JSON.stringify([identifier(gameId), identifier(sessionId)]);
	return {
		subscribe(gameId: string, sessionId: string, listener: UIEventListener) {
			const id = key(gameId, sessionId),
				entries = listeners.get(id) ?? new Set<UIEventListener>();
			entries.add(listener);
			listeners.set(id, entries);
			return () => {
				entries.delete(listener);
				if (!entries.size) listeners.delete(id);
			};
		},
		publish(gameId: string, sessionId: string, transactionId: string, events: UIEvent[]): number {
			let failures = 0;
			for (const event of events)
				for (const listener of [...(listeners.get(key(gameId, sessionId)) ?? [])]) {
					try {
						const result: unknown = listener(
							freeze(structuredClone({ ...event, gameId, sessionId, transactionId }))
						);
						// UI listeners are synchronous. Consume accidental async rejections without undoing a commit.
						if (
							result !== null &&
							(typeof result === 'object' || typeof result === 'function') &&
							'then' in result &&
							typeof result.then === 'function'
						) {
							failures++;
							void Promise.resolve(result).catch(() => {});
						}
					} catch {
						failures++;
					}
				}
			return failures;
		}
	};
}
