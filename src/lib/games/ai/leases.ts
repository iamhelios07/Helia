import type { StorageRequest } from '#lib/storage/protocol.js';

import { aiError, AI_LIMITS } from './protocol.js';
export class SessionLeases {
	private leases = new Map<
		string,
		{ gameId: string; sessionId: string; expires: number; abort: AbortController; rounds: number }
	>();
	begin(gameId: string, sessionId: string): string {
		this.prune();
		if ([...this.leases.values()].some((l) => l.gameId === gameId && l.sessionId === sessionId)) {
			throw aiError('busy');
		}
		const id = crypto.randomUUID();
		this.leases.set(id, {
			gameId,
			sessionId,
			expires: Date.now() + AI_LIMITS.timeoutMs,
			abort: new AbortController(),
			rounds: 0
		});
		return id;
	}
	require(id: string, gameId: string, sessionId: string) {
		this.prune();
		const lease = this.leases.get(id);
		if (!lease || lease.gameId !== gameId || lease.sessionId !== sessionId) {
			throw aiError('canceled');
		}
		return lease;
	}
	round(id: string, gameId: string, sessionId: string): AbortSignal {
		const lease = this.require(id, gameId, sessionId);
		if (++lease.rounds > AI_LIMITS.rounds * (AI_LIMITS.retries + 1)) {
			throw aiError('limit');
		}
		return lease.abort.signal;
	}
	release(id: string, gameId: string, sessionId: string) {
		const lease = this.leases.get(id);
		if (lease?.gameId === gameId && lease.sessionId === sessionId) {
			lease.abort.abort();
			this.leases.delete(id);
		}
	}
	guard(request: StorageRequest) {
		this.prune();
		if (request.kind !== 'commit' && request.kind !== 'prune') {
			return;
		}
		const affected =
			request.kind === 'prune'
				? [request.sessionId]
				: [
						...request.records
							.filter((r) => ['progress', 'transactions', 'messages'].includes(r.table))
							.map((r) => r.sessionId),
						...request.deleteSessions
					];
		const supplied = request.kind === 'commit' ? request.aiLease : undefined;
		if (supplied) {
			const lease = this.leases.get(supplied);
			if (
				!lease ||
				lease.gameId !== request.gameId ||
				affected.some((id) => id !== lease.sessionId)
			) {
				throw aiError('canceled');
			}
		}
		for (const [id, lease] of this.leases) {
			if (
				lease.gameId === request.gameId &&
				affected.includes(lease.sessionId) &&
				id !== supplied
			) {
				throw aiError('busy');
			}
		}
	}
	private prune() {
		for (const [id, lease] of this.leases) {
			if (Date.now() >= lease.expires) {
				lease.abort.abort();
				this.leases.delete(id);
			}
		}
	}
}
export const hostAILeases = new SessionLeases();
