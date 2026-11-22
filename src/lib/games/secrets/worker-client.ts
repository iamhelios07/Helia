import { SECRET_ERROR, type SecretReadAccess, type SecretOperation } from './protocol.js';

export function createSecretClient(post: (message: unknown, ports: MessagePort[]) => void) {
	const ports = new Set<MessagePort>();
	const request = (operation: SecretOperation): Promise<unknown> =>
		new Promise((resolve, reject) => {
			const channel = new MessageChannel();
			ports.add(channel.port1);
			channel.port1.onmessage = ({ data }: MessageEvent<{ ok: boolean; result?: unknown }>) => {
				ports.delete(channel.port1);
				channel.port1.close();
				if (data?.ok === true) {
					resolve(data.result);
				} else {
					reject(new TypeError(SECRET_ERROR));
				}
			};
			post({ kind: 'secret', operation }, [channel.port2]);
		});
	const access: SecretReadAccess = {
		async has(name) {
			const result = await request({ kind: 'has', name });
			if (typeof result !== 'boolean') {
				throw new TypeError(SECRET_ERROR);
			}
			return result;
		},
		async ref(name) {
			const result = await request({ kind: 'ref', name });
			if (typeof result !== 'string') {
				throw new TypeError(SECRET_ERROR);
			}
			return result;
		}
	};
	return {
		access,
		dispose() {
			for (const port of ports) {
				port.close();
			}
			ports.clear();
		}
	};
}
