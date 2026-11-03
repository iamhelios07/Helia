import {
	boundedText,
	CreatorRuntimeError,
	encodeInput,
	parseInput,
	FAILURE_CODES,
	parseResult,
	SANDBOX_LIMITS,
	type ActionRunner,
	type CreatorFailureCode
} from './protocol.js';

let active = 0;
/** The Worker supplies termination and UI responsiveness; QuickJS supplies the capability boundary. */
export const runCreatorAction: ActionRunner = async (input, options = {}) => {
	if (options.signal?.aborted) return Promise.reject(new CreatorRuntimeError('canceled'));
	if (typeof Worker === 'undefined') return Promise.reject(new CreatorRuntimeError('unavailable'));
	if (active >= 4) return Promise.reject(new CreatorRuntimeError('busy'));
	const request = encodeInput(input);
	const schema = parseInput(JSON.parse(request)).schema;
	return new Promise((resolve, reject) => {
		let worker: Worker;
		try {
			worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
		} catch {
			reject(new CreatorRuntimeError('unavailable'));
			return;
		}
		active++;
		let done = false;
		function finish(operation: () => void) {
			if (done) return;
			done = true;
			clearTimeout(timer);
			options.signal?.removeEventListener('abort', cancel);
			worker.terminate();
			active--;
			operation();
		}
		const cancel = () => finish(() => reject(new CreatorRuntimeError('canceled')));
		const timer = setTimeout(
			() => finish(() => reject(new CreatorRuntimeError('timeout'))),
			SANDBOX_LIMITS.wallTimeMs
		);
		worker.onerror = (event) => {
			event.preventDefault();
			finish(() => reject(new CreatorRuntimeError('unavailable')));
		};
		worker.onmessageerror = () => finish(() => reject(new CreatorRuntimeError('protocol')));
		worker.onmessage = (event) =>
			finish(() => {
				try {
					if (typeof event.data !== 'string') throw new CreatorRuntimeError('protocol');
					const reply: unknown = JSON.parse(boundedText(event.data));
					if (!reply || typeof reply !== 'object' || !('ok' in reply))
						throw new CreatorRuntimeError('protocol');
					if (reply.ok === true && 'result' in reply) resolve(parseResult(reply.result, schema));
					else if (
						reply.ok === false &&
						'code' in reply &&
						FAILURE_CODES.includes(reply.code as CreatorFailureCode)
					)
						reject(
							new CreatorRuntimeError(
								reply.code as CreatorFailureCode,
								'scriptId' in reply && typeof reply.scriptId === 'string'
									? reply.scriptId.slice(0, 128)
									: null,
								'ruleId' in reply && typeof reply.ruleId === 'string'
									? reply.ruleId.slice(0, 128)
									: null,
								'reason' in reply && typeof reply.reason === 'string'
									? reply.reason.slice(0, 1024)
									: null
							)
						);
					else throw new CreatorRuntimeError('protocol');
				} catch (error) {
					reject(
						error instanceof CreatorRuntimeError ? error : new CreatorRuntimeError('protocol')
					);
				}
			});
		options.signal?.addEventListener('abort', cancel, { once: true });
		if (options.signal?.aborted) cancel();
		else {
			try {
				worker.postMessage(request);
			} catch {
				finish(() => reject(new CreatorRuntimeError('protocol')));
			}
		}
	});
};
