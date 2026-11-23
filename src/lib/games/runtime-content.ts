import { convertFileSrc } from '@tauri-apps/api/core';

import { isDesktopBuild, isTauri } from '#lib/platform/index.js';

import type { Game } from './model.js';

const artifacts = new Map<string, Promise<unknown>>();
export function assetURL(gameId: string, reference: string): string {
	if (!/^helia-asset:[a-f0-9]{64}$/.test(reference)) {
		return reference;
	}
	const path = encodeURIComponent(gameId) + '/' + reference.slice(12);
	return isDesktopBuild
		? convertFileSrc(path, 'helia-media')
		: new URL('/api/games/' + path.replace('/', '/assets/'), globalThis.location.origin).href;
}
export function loadArtifact(gameId: string, hash: string): Promise<unknown> {
	if (!/^[a-f0-9]{64}$/.test(hash)) {
		throw Error('Invalid artifact');
	}
	const key = gameId + ':' + hash;
	let result = artifacts.get(key);
	if (!result) {
		result = readArtifact(gameId, hash).catch((error: unknown) => {
			artifacts.delete(key);
			throw error;
		});
		if (artifacts.size >= 32) {
			artifacts.delete(artifacts.keys().next().value!);
		}
		artifacts.set(key, result);
	}
	return result;
}
async function readArtifact(gameId: string, hash: string): Promise<unknown> {
	if (isDesktopBuild) {
		const host: unknown = Reflect.get(window, '__HELIA_STORAGE__');
		if (!isTauri() || window !== window.top || typeof host !== 'function') {
			throw Error('Artifact unavailable');
		}
		return host({ kind: 'artifact', gameId, hash });
	}
	const response = await fetch(`/api/games/${encodeURIComponent(gameId)}/artifacts/${hash}`, {
		cache: 'force-cache',
		signal: AbortSignal.timeout(15_000)
	});
	if (!response.ok) {
		throw Error('Artifact unavailable');
	}
	return response.json();
}
export async function runtimeScripts(
	scripts: Game['scripts'],
	gameId?: string,
	signal?: AbortSignal
): Promise<Game['scripts']> {
	if (signal?.aborted) {
		throw new DOMException('Aborted', 'AbortError');
	}
	let abort: () => void = () => {};
	const canceled = new Promise<never>((_resolve, reject) => {
		abort = () => reject(new DOMException('Aborted', 'AbortError'));
		signal?.addEventListener('abort', abort, { once: true });
	});
	try {
		return await Promise.race([resolveScripts(scripts, gameId), canceled]);
	} finally {
		signal?.removeEventListener('abort', abort);
	}
}
async function resolveScripts(scripts: Game['scripts'], gameId?: string): Promise<Game['scripts']> {
	const entries = await Promise.all(
		Object.entries(scripts).map(async ([id, script]) => {
			if (!script.artifact) {
				return [id, script];
			}
			if (!gameId) {
				throw Error('Missing runtime scope');
			}
			const value = (await loadArtifact(gameId, script.artifact)) as {
				version?: unknown;
				source?: unknown;
			};
			if (
				value.version !== 1 ||
				typeof value.source !== 'string' ||
				value.source.length > 1024 * 1024
			) {
				throw Error('Invalid runtime script');
			}
			return [id, { language: script.language, source: '', compiled: value.source }];
		})
	);
	return Object.fromEntries(entries);
}
