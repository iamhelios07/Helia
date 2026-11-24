import { MigrationFailure } from '../migration/failure.js';

const MAX_WORKERS = 4;
let active = 0;
const waiting = new Set<() => void>();
/** Actions keep their immediate busy response; migrations wait on this same counter. */
export function tryWorkerSlot(): (() => void) | null {
	if (active >= MAX_WORKERS) {
		return null;
	}
	active++;
	let released = false;
	return () => {
		if (released) {
			return;
		}
		released = true;
		active--;
		for (const wake of waiting) {
			wake();
		}
	};
}
export function waitWorkerSlot(signal: AbortSignal): Promise<() => void> {
	return new Promise((resolve, reject) => {
		const cancel = () => {
			cleanup();
			reject(new MigrationFailure('canceled'));
		};
		const wake = () => {
			if (signal.aborted) {
				cancel();
				return;
			}
			const release = tryWorkerSlot();
			if (release) {
				cleanup();
				resolve(release);
			}
		};
		const cleanup = () => {
			waiting.delete(wake);
			signal.removeEventListener('abort', cancel);
		};
		waiting.add(wake);
		signal.addEventListener('abort', cancel, { once: true });
		wake();
	});
}
