import type { MigrationBudget } from '../migration/budget.js';
import type { MigrationWorkerRequest, MigrationWorkerResult } from './migration-protocol.js';

import {
	MigrationFailure,
	MIGRATION_FAILURE_KINDS,
	type MigrationFailureKind
} from '../migration/failure.js';
import { migrationText } from './migration-protocol.js';
import { SANDBOX_LIMITS } from './protocol.js';
import { waitWorkerSlot } from './worker-slots.js';

/** The only messages supported here are migration results; there is no RPC dispatch. */
export async function runMigrationWorker(
	request: MigrationWorkerRequest,
	budget: MigrationBudget,
	onResult: (result: MigrationWorkerResult) => void,
	signal: AbortSignal = budget.signal
): Promise<void> {
	budget.checkpoint();
	if (request.runs?.length === 0) {
		return;
	}
	if (typeof Worker === 'undefined') {
		throw new MigrationFailure('unavailable');
	}
	const text = migrationText(JSON.stringify(request));
	const reservation = budget.reserve(text.length * 2);
	let release: (() => void) | undefined;
	try {
		release = await waitWorkerSlot(signal);
		budget.checkpoint();
		await new MigrationWorkerExecution(budget, signal, onResult).run(
			text,
			request.runs?.length ?? 1
		);
	} catch (error) {
		budget.checkpoint();
		throw error;
	} finally {
		release?.();
		reservation.dispose();
	}
}
class MigrationWorkerExecution {
	private worker?: Worker;
	private timer?: ReturnType<typeof setTimeout>;
	constructor(
		private budget: MigrationBudget,
		private signal: AbortSignal,
		private result: (result: MigrationWorkerResult) => void
	) {}
	run(text: string, count: number): Promise<void> {
		return new Promise((resolve, reject) => {
			let done = false;
			let received = 0;
			const finish = (error?: unknown) => {
				if (done) {
					return;
				}
				done = true;
				clearTimeout(this.timer);
				this.signal.removeEventListener('abort', cancel);
				this.worker?.terminate();
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			};
			const cancel = () => finish(new MigrationFailure('canceled'));
			const touch = () => {
				clearTimeout(this.timer);
				this.timer = setTimeout(
					() => finish(new MigrationFailure('timeout')),
					SANDBOX_LIMITS.wallTimeMs
				);
			};
			try {
				this.worker = new Worker(new URL('./migration-worker.ts', import.meta.url), {
					type: 'module'
				});
				this.worker.onerror = (event) => {
					event.preventDefault();
					finish(new MigrationFailure('unavailable'));
				};
				this.worker.onmessageerror = () => finish(new MigrationFailure('unavailable'));
				this.worker.onmessage = (event: MessageEvent<unknown>) => {
					try {
						if (done) {
							return;
						}
						this.receive(event.data);
						touch();
						if (++received === count) {
							finish();
						}
					} catch (error) {
						finish(error);
					}
				};
				this.signal.addEventListener('abort', cancel, { once: true });
				if (this.signal.aborted) {
					cancel();
					return;
				}
				touch();
				this.worker.postMessage(text);
			} catch {
				finish(new MigrationFailure('unavailable'));
			}
		});
	}
	private receive(data: unknown) {
		this.budget.checkpoint();
		if (typeof data !== 'string') {
			throw new MigrationFailure('unavailable');
		}
		const reservation = this.budget.reserve(data.length * 2);
		try {
			const reply = JSON.parse(migrationText(data));
			if (reply.ok === false && MIGRATION_FAILURE_KINDS.includes(reply.kind)) {
				throw new MigrationFailure(reply.kind as MigrationFailureKind, {
					scriptId: typeof reply.scriptId === 'string' ? reply.scriptId.slice(0, 128) : null,
					migration: typeof reply.migration === 'string' ? reply.migration.slice(0, 128) : null
				});
			}
			if (reply.ok !== true || !reply.result || !['catalog', 'state'].includes(reply.result.kind)) {
				throw new MigrationFailure('unavailable');
			}
			this.result(reply.result as MigrationWorkerResult);
		} finally {
			reservation.dispose();
		}
	}
}
