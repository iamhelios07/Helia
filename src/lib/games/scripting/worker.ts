import { evaluateAction } from './engine.js';
import { boundedText, CreatorRuntimeError, parseInput, type WorkerReply } from './protocol.js';

// One request per disposable worker. Neither this scope nor its APIs are exposed to QuickJS.
globalThis.onmessage = async (event: MessageEvent<unknown>) => {
	let reply: WorkerReply;
	try {
		if (typeof event.data !== 'string') throw new CreatorRuntimeError('input');
		const request = parseInput(JSON.parse(boundedText(event.data)));
		reply = { ok: true, result: await evaluateAction(request) };
	} catch (error) {
		reply =
			error instanceof CreatorRuntimeError
				? {
						ok: false,
						code: error.code,
						scriptId: error.scriptId,
						ruleId: error.ruleId,
						reason: error.reason
					}
				: { ok: false, code: 'execution', scriptId: null };
	}
	try {
		globalThis.postMessage(boundedText(JSON.stringify(reply)));
	} catch {
		globalThis.postMessage(JSON.stringify({ ok: false, code: 'protocol', scriptId: null }));
	}
};
