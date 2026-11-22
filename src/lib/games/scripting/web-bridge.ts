import type {
	QuickJSContext,
	QuickJSDeferredPromise,
	QuickJSHandle,
	QuickJSRuntime
} from 'quickjs-emscripten-core';

import { decodeBytes, encodeBytes, NETWORK_LIMITS } from '#lib/games/network/protocol.js';

import { ExecutionBudget } from './budget.js';
import { CreatorRuntimeError } from './protocol.js';
import { ScriptWebHost } from './web-host.js';

/** Handles native promises without exposing native objects or evaluating guest text on the host. */
export class ScriptWebBridge {
	private readonly host: ScriptWebHost;
	private readonly pending = new Set<QuickJSDeferredPromise>();
	private disposed = false;
	private failure?: CreatorRuntimeError;
	private wake = () => {};
	readonly callbacks: QuickJSHandle[];
	constructor(
		private vm: QuickJSContext,
		send: typeof fetch,
		private budget: ExecutionBudget,
		secrets?: import('../secrets/protocol.js').SecretReadAccess
	) {
		this.host = new ScriptWebHost(send, secrets);
		this.callbacks = [
			vm.newFunction('webSync', (json) => vm.newString(this.host.sync(vm.getString(json)))),
			vm.newFunction('webAsync', (json) => this.request(vm.getString(json))),
			vm.newFunction('encodeBuffer', (handle) => {
				try {
					using bytes = vm.getArrayBuffer(handle);
					if (bytes.value.byteLength > NETWORK_LIMITS.requestBytes) {
						throw new TypeError('Body limit');
					}
					return vm.newString(encodeBytes(bytes.value));
				} catch {
					return { error: vm.newError('Invalid byte buffer') };
				}
			}),
			vm.newFunction('decodeBuffer', (handle) => {
				try {
					const bytes = decodeBytes(vm.getString(handle));
					if (bytes.byteLength > NETWORK_LIMITS.responseBytes) {
						throw new TypeError('Body limit');
					}
					return vm.newArrayBuffer(bytes.buffer);
				} catch {
					return { error: vm.newError('Invalid byte buffer') };
				}
			})
		];
	}
	private request(json: string): QuickJSHandle | { error: QuickJSHandle } {
		if (this.pending.size >= NETWORK_LIMITS.pending) {
			return { error: this.vm.newError('Too many Web operations') };
		}
		const deferred = this.vm.newPromise();
		this.pending.add(deferred);
		void this.host.async(json).then((result) => {
			if (this.disposed) {
				return;
			}
			try {
				this.budget.run(() => {
					using value = this.vm.newString(result);
					deferred.resolve(value);
				});
			} catch {
				this.failure = new CreatorRuntimeError('execution');
				deferred.dispose();
			} finally {
				this.pending.delete(deferred);
				this.wake();
			}
		});
		return deferred.handle;
	}
	async resolve(handle: QuickJSHandle, runtime: QuickJSRuntime): Promise<QuickJSHandle> {
		for (;;) {
			if (this.failure) {
				throw this.failure;
			}
			this.drain(runtime);
			const state = this.vm.getPromiseState(handle);
			if (state.type === 'fulfilled') {
				if (this.pending.size) {
					state.value.dispose();
					throw new CreatorRuntimeError('execution');
				}
				return state.value;
			}
			if (state.type === 'rejected') {
				state.error.dispose();
				throw new CreatorRuntimeError('execution');
			}
			if (!this.pending.size) {
				throw new CreatorRuntimeError('execution');
			}
			await new Promise<void>((resolve) => {
				this.wake = resolve;
			});
		}
	}
	private drain(runtime: QuickJSRuntime) {
		while (runtime.hasPendingJob()) {
			const jobs = this.budget.run(() => runtime.executePendingJobs(1));
			if (jobs.error) {
				jobs.error.dispose();
				throw new CreatorRuntimeError(this.budget.expired() ? 'timeout' : 'execution');
			}
			if (this.budget.expired()) {
				throw new CreatorRuntimeError('timeout');
			}
		}
	}
	dispose() {
		this.disposed = true;
		for (const deferred of this.pending) {
			deferred.dispose();
		}
		for (const handle of this.callbacks) {
			handle.dispose();
		}
		this.pending.clear();
	}
}
