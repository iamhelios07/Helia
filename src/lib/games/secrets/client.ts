import { isDesktopBuild, isTauri } from '#lib/platform/index.js';

import {
	secretScope,
	secretOperation,
	SECRET_ERROR,
	type SecretOperation,
	type SecretAccess
} from './protocol.js';

export function gameSecrets(game: string): SecretAccess {
	const gameId = secretScope(game);
	async function request(input: SecretOperation): Promise<unknown> {
		const operation = secretOperation(input);
		try {
			if (isDesktopBuild) {
				const host: unknown = Reflect.get(window, '__HELIA_GAME_SECRETS__');
				if (!isTauri() || window !== window.top || typeof host !== 'function') {
					throw new TypeError(SECRET_ERROR);
				}
				return await host(gameId, operation);
			}
			const response = await fetch(`/api/games/${encodeURIComponent(gameId)}/secrets`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(operation)
			});
			if (!response.ok) {
				throw new TypeError(SECRET_ERROR);
			}
			const data: unknown = await response.json();
			if (!data || typeof data !== 'object' || !('result' in data)) {
				throw new TypeError(SECRET_ERROR);
			}
			return data.result;
		} catch {
			throw new TypeError(SECRET_ERROR);
		}
	}
	return {
		async has(name) {
			const result = await request({ kind: 'has', name });
			if (typeof result !== 'boolean') {
				throw new TypeError(SECRET_ERROR);
			}
			return result;
		},
		async ref(name) {
			const result = await request({ kind: 'ref', name });
			if (typeof result !== 'string' || result.length > 256) {
				throw new TypeError(SECRET_ERROR);
			}
			return result;
		},
		async set(name, value, options) {
			await request({ kind: 'set', name, value, url: options.url });
		},
		async remove(name) {
			await request({ kind: 'remove', name });
		}
	};
}
