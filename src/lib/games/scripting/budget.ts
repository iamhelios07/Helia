import { SANDBOX_LIMITS } from './protocol.js';

/** Charge interpreter execution, not time spent waiting for host IO. */
export class ExecutionBudget {
	private remaining = SANDBOX_LIMITS.cpuTimeMs;
	private deadline = Infinity;
	expired = () => this.remaining <= 0 || performance.now() >= this.deadline;
	run<T>(operation: () => T): T {
		const start = performance.now();
		this.deadline = start + this.remaining;
		try {
			return operation();
		} finally {
			this.remaining -= performance.now() - start;
			this.deadline = Infinity;
		}
	}
}
