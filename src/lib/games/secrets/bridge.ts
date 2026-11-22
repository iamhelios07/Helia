import {
	secretOperation,
	SECRET_ERROR,
	type SecretAccess,
	type SecretOperation,
	type SecretReadAccess
} from './protocol.js';

export async function executeSecret(access: SecretAccess, input: unknown) {
	const operation = secretOperation(input);
	if (operation.kind === 'has') {
		return access.has(operation.name);
	}
	if (operation.kind === 'ref') {
		return access.ref(operation.name);
	}
	if (operation.kind === 'set') {
		await access.set(operation.name, operation.value, { url: operation.url });
	} else {
		await access.remove(operation.name);
	}
	return null;
}
/** The game/session identity is captured by the host, never read from a creator message. */
export class SecretBridge {
	private pending = 0;
	private disposed = false;
	constructor(
		private access: SecretAccess,
		private send: (message: unknown) => void
	) {}
	async receive(input: unknown) {
		if (!input || typeof input !== 'object' || this.disposed) {
			return;
		}
		const message = input as Record<string, unknown>;
		if (
			message.kind !== 'secrets' ||
			typeof message.id !== 'string' ||
			!/^\d{1,12}$/.test(message.id)
		) {
			return;
		}
		if (this.pending >= 16) {
			this.send({ kind: 'secret-response', id: message.id, ok: false, error: SECRET_ERROR });
			return;
		}
		this.pending++;
		try {
			const result = await executeSecret(this.access, message.operation);
			if (!this.disposed) {
				this.send({ kind: 'secret-response', id: message.id, ok: true, result });
			}
		} catch {
			if (!this.disposed) {
				this.send({ kind: 'secret-response', id: message.id, ok: false, error: SECRET_ERROR });
			}
		} finally {
			this.pending--;
		}
	}
	dispose() {
		this.disposed = true;
	}
}
export class SecretWorkerBridge {
	private ports = new Set<MessagePort>();
	private disposed = false;
	constructor(
		private access: SecretReadAccess,
		private activity: () => void
	) {}
	receive(event: MessageEvent<unknown>): boolean {
		const message = event.data as { kind?: unknown; operation?: unknown } | null;
		if (!message || message.kind !== 'secret') {
			return false;
		}
		const port = event.ports[0];
		if (!port) {
			return true;
		}
		if (this.disposed || this.ports.size >= 16) {
			port.postMessage({ ok: false });
			port.close();
			return true;
		}
		this.ports.add(port);
		void this.execute(message.operation)
			.then(
				(result) => {
					if (!this.disposed) {
						port.postMessage({ ok: true, result });
					}
				},
				() => {
					if (!this.disposed) {
						port.postMessage({ ok: false });
					}
				}
			)
			.finally(() => {
				this.ports.delete(port);
				port.close();
				this.activity();
			});
		return true;
	}
	private async execute(input: unknown) {
		const operation: SecretOperation = secretOperation(input);
		if (operation.kind === 'has') {
			return this.access.has(operation.name);
		}
		if (operation.kind === 'ref') {
			return this.access.ref(operation.name);
		}
		throw new TypeError(SECRET_ERROR);
	}
	dispose() {
		this.disposed = true;
		for (const port of this.ports) {
			port.close();
		}
		this.ports.clear();
	}
}
