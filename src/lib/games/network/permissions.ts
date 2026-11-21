import type { NetworkPermission } from './fetch.js';

interface PendingPermission {
	abort: AbortController;
	result: Promise<boolean>;
	users: number;
}
/** Consent is shared by concurrent requests, but abandoned dialogs are cancelled. */
export class NetworkPermissions {
	private readonly origins = new Map<string, boolean | PendingPermission>();
	constructor(private prompt: NetworkPermission) {}
	allow: NetworkPermission = (origin, signal) => {
		if (signal.aborted) {
			return Promise.reject(signal.reason);
		}
		let entry = this.origins.get(origin);
		if (typeof entry === 'boolean') {
			return Promise.resolve(entry);
		}
		if (!entry) {
			const abort = new AbortController();
			const pending: PendingPermission = { abort, users: 0, result: Promise.resolve(false) };
			pending.result = Promise.resolve()
				.then(() => this.prompt(origin, abort.signal))
				.then((value) => {
					if (this.origins.get(origin) === pending) {
						this.origins.set(origin, value);
					}
					return value;
				});
			this.origins.set(origin, pending);
			entry = pending;
		}
		return this.wait(origin, entry, signal);
	};
	private wait(origin: string, entry: PendingPermission, signal: AbortSignal): Promise<boolean> {
		entry.users++;
		return new Promise((resolve, reject) => {
			let finished = false;
			const cleanup = () => {
				if (finished) {
					return false;
				}
				finished = true;
				signal.removeEventListener('abort', cancel);
				entry.users--;
				if (!entry.users && this.origins.get(origin) === entry) {
					this.origins.delete(origin);
					entry.abort.abort();
				}
				return true;
			};
			const cancel = () => {
				if (cleanup()) {
					reject(signal.reason);
				}
			};
			signal.addEventListener('abort', cancel, { once: true });
			void entry.result.then(
				(value) => {
					if (cleanup()) {
						resolve(value);
					}
				},
				() => {
					if (cleanup()) {
						resolve(false);
					}
				}
			);
		});
	}
	dispose() {
		for (const entry of this.origins.values()) {
			if (typeof entry !== 'boolean') {
				entry.abort.abort();
			}
		}
		this.origins.clear();
	}
}
