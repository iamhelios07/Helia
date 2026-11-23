import { FetchBridge } from '#lib/games/network/bridge.js';
import { requestNetworkPermission } from '#lib/games/network/permission.js';
import { NETWORK_LIMITS } from '#lib/games/network/protocol.js';
import { networkHop } from '#lib/games/network/transport.js';
import { runtimeScripts } from '#lib/games/runtime-content.js';
import { SecretWorkerBridge } from '#lib/games/secrets/bridge.js';
import { gameSecrets } from '#lib/games/secrets/client.js';
import { unavailableSecrets } from '#lib/games/secrets/protocol.js';

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
	if (options.signal?.aborted) {
		throw new CreatorRuntimeError('canceled');
	}
	if (typeof Worker === 'undefined') {
		throw new CreatorRuntimeError('unavailable');
	}
	if (active >= 4) {
		throw new CreatorRuntimeError('busy');
	}
	active++;
	try {
		let request = encodeInput(input);
		const captured = parseInput(JSON.parse(request));
		if (Object.values(captured.scripts).some((script) => script.artifact)) {
			request = encodeInput({
				...captured,
				scripts: await runtimeScripts(captured.scripts, options.gameId, options.signal)
			});
		}
		if (options.signal?.aborted) {
			throw new CreatorRuntimeError('canceled');
		}
		const execution = new WorkerExecution(createWorker(), options);
		return decodeWorkerReply(await execution.run(request), captured.schema);
	} catch (error) {
		if (options.signal?.aborted) {
			throw new CreatorRuntimeError('canceled');
		}
		throw error instanceof CreatorRuntimeError ? error : new CreatorRuntimeError('protocol');
	} finally {
		active--;
	}
};
function createWorker(): Worker {
	try {
		return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
	} catch {
		throw new CreatorRuntimeError('unavailable');
	}
}
class WorkerExecution {
	private done = false;
	private reject: (error: CreatorRuntimeError) => void = () => {};
	private readonly watchdog = new ActionWatchdog(() => this.fail('timeout'));
	private readonly network: FetchBridge;
	private readonly secrets: SecretWorkerBridge;
	constructor(
		private worker: Worker,
		private options: import('./protocol.js').RunOptions
	) {
		this.network = new FetchBridge(
			requestNetworkPermission,
			this.activity,
			(count) => this.watchdog.touch(count),
			(request, signal) => networkHop(request, signal, options.gameId)
		);
		const access =
			options.secrets ?? (options.gameId ? gameSecrets(options.gameId) : unavailableSecrets);
		this.secrets = new SecretWorkerBridge(access, this.activity);
	}
	private activity = () => {
		this.watchdog.touch();
		this.options.onActivity?.();
	};
	private cancel = () => this.fail('canceled');
	private fail(code: CreatorFailureCode) {
		this.finish(() => this.reject(new CreatorRuntimeError(code)));
	}
	run(request: string): Promise<unknown> {
		return new Promise((resolve, reject) => {
			this.reject = reject;
			this.watchdog.touch();
			this.worker.onerror = (event) => {
				event.preventDefault();
				this.fail('unavailable');
			};
			this.worker.onmessageerror = () => this.fail('protocol');
			this.worker.onmessage = (event) => {
				if (this.done || this.network.receive(event) || this.secrets.receive(event)) {
					return;
				}
				this.finish(() => resolve(event.data));
			};
			this.options.signal?.addEventListener('abort', this.cancel, { once: true });
			if (this.options.signal?.aborted) {
				this.cancel();
				return;
			}
			try {
				this.worker.postMessage(request);
			} catch {
				this.fail('protocol');
			}
		});
	}
	private finish(operation: () => void) {
		if (this.done) {
			return;
		}
		this.done = true;
		this.watchdog.dispose();
		this.network.dispose();
		this.secrets.dispose();
		this.options.signal?.removeEventListener('abort', this.cancel);
		this.worker.terminate();
		operation();
	}
}

class ActionWatchdog {
	private waiting = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private disposed = false;
	constructor(private expire: () => void) {}
	touch(waiting = this.waiting) {
		clearTimeout(this.timer);
		this.waiting = waiting;
		if (!this.disposed) {
			this.timer = setTimeout(
				this.expire,
				waiting ? NETWORK_LIMITS.idleMs : SANDBOX_LIMITS.wallTimeMs
			);
		}
	}
	dispose() {
		this.disposed = true;
		clearTimeout(this.timer);
	}
}

function decodeWorkerReply(
	data: unknown,
	schema: ReturnType<typeof parseInput>['schema']
): ReturnType<typeof parseResult> {
	if (typeof data !== 'string') {
		throw new CreatorRuntimeError('protocol');
	}
	const reply: unknown = JSON.parse(boundedText(data));
	if (!reply || typeof reply !== 'object' || !('ok' in reply)) {
		throw new CreatorRuntimeError('protocol');
	}
	if (reply.ok === true && 'result' in reply) {
		return parseResult(reply.result, schema);
	} else if (
		reply.ok === false &&
		'code' in reply &&
		FAILURE_CODES.includes(reply.code as CreatorFailureCode)
	) {
		throw new CreatorRuntimeError(
			reply.code as CreatorFailureCode,
			failureDetail(reply, 'scriptId', 128),
			failureDetail(reply, 'ruleId', 128),
			failureDetail(reply, 'reason', 1024)
		);
	} else {
		throw new CreatorRuntimeError('protocol');
	}
}

function failureDetail(reply: object, key: string, limit: number): string | null {
	const value: unknown = Reflect.get(reply, key);
	return typeof value === 'string' ? value.slice(0, limit) : null;
}
