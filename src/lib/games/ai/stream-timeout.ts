import { aiError, AI_LIMITS } from './protocol.js';

/** A round can run indefinitely while provider bytes continue to arrive. */
export function streamTimeout(parent: AbortSignal) {
	const abort = new AbortController();
	const signal = AbortSignal.any([parent, abort.signal]);
	let timer: ReturnType<typeof setTimeout>;
	let disposed = false;
	const dispose = () => clearTimeout(timer);
	const touch = () => {
		dispose();
		if (!disposed && !signal.aborted) {
			timer = setTimeout(() => abort.abort(aiError('timeout')), AI_LIMITS.streamIdleMs);
		}
	};
	signal.addEventListener('abort', dispose, { once: true });
	touch();
	return {
		signal,
		touch,
		dispose: () => {
			disposed = true;
			dispose();
			signal.removeEventListener('abort', dispose);
		}
	};
}

export function isStreamTimeout(error: unknown): boolean {
	return error instanceof Error && error.name === 'TimeoutError';
}
