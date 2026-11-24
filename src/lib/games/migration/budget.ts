import { MigrationFailure } from './failure.js';

export interface MigrationBudgetLimits {
	entries: number;
	bytes: number;
	deadlineMs: number;
}
/** Provisional memory ceiling, to be tuned by B5 measurements. */
export const MIGRATION_BUDGET_LIMITS: MigrationBudgetLimits = Object.freeze({
	entries: 20_000,
	bytes: 128 * 1024 * 1024,
	deadlineMs: 600_000
});
export const MIGRATION_OBJECT_FACTOR = 3;
export interface Reservation {
	dispose(): void;
}
export class MigrationBudget {
	readonly signal: AbortSignal;
	private readonly abort = new AbortController();
	private readonly timer: ReturnType<typeof setTimeout>;
	private readonly deadline: number;
	private disposed = false;
	private timedOut = false;
	private reservations = new Set<Reservation>();
	private bytes = 0;
	private entries = 0;
	constructor(
		readonly limits = MIGRATION_BUDGET_LIMITS,
		signal?: AbortSignal
	) {
		if (Object.values(limits).some((value) => !Number.isFinite(value) || value < 0)) {
			throw Error('Invalid migration budget');
		}
		this.deadline = performance.now() + limits.deadlineMs;
		this.signal = AbortSignal.any([this.abort.signal, ...(signal ? [signal] : [])]);
		this.timer = setTimeout(() => {
			this.timedOut = true;
			this.abort.abort();
		}, limits.deadlineMs);
	}
	get usage() {
		return { bytes: this.bytes, entries: this.entries };
	}
	checkpoint(): void {
		if (this.disposed) {
			throw Error('Disposed migration budget');
		}
		if (this.timedOut || performance.now() >= this.deadline) {
			throw new MigrationFailure('timeout');
		}
		if (this.signal.aborted) {
			throw new MigrationFailure('canceled');
		}
	}
	reserve(bytes: number): Reservation {
		this.checkpoint();
		if (!Number.isFinite(bytes) || bytes < 0 || this.bytes + bytes > this.limits.bytes) {
			throw new MigrationFailure('limit');
		}
		this.bytes += bytes;
		const reservation: Reservation = {
			dispose: () => {
				if (this.reservations.delete(reservation)) {
					this.bytes -= bytes;
				}
			}
		};
		this.reservations.add(reservation);
		return reservation;
	}
	addEntry(): void {
		this.checkpoint();
		if (this.entries >= this.limits.entries) {
			throw new MigrationFailure('limit');
		}
		this.entries++;
	}
	removeEntry(): void {
		this.entries = Math.max(0, this.entries - 1);
	}
	dispose(): void {
		clearTimeout(this.timer);
		for (const reservation of this.reservations) {
			reservation.dispose();
		}
		this.entries = 0;
		this.disposed = true;
		this.abort.abort();
	}
}
