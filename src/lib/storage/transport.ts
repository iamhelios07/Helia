import { isDesktopBuild, isTauri } from '#lib/platform/index.js';

import { synchronizedStorage } from './sync-client.js';

async function send(request: unknown): Promise<unknown> {
	if (isDesktopBuild) {
		if (!isTauri()) {
			throw new Error('데스크톱 저장소는 Helia 앱에서 사용할 수 있어요.');
		}
		const host: unknown = Reflect.get(window, '__HELIA_STORAGE__');
		if (window !== window.top || typeof host !== 'function') {
			throw new Error('데스크톱 저장소 접근이 허용되지 않았어요.');
		}
		return host(request);
	}
	const response = await fetch('/api/storage', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(request)
	});
	const result: unknown = await response.json().catch(() => null);
	if (!response.ok) {
		throw new Error(
			typeof result === 'object' &&
				result !== null &&
				'error' in result &&
				typeof result.error === 'string'
				? result.error
				: '게임 저장소를 사용할 수 없어요.'
		);
	}
	return result;
}

async function loadAsset(gameId: string, hash: string): Promise<string> {
	if (isDesktopBuild) {
		const result = (await send({ kind: 'asset', gameId, hash })) as { data: string };
		if (typeof result.data !== 'string' || !result.data.startsWith('data:')) {
			throw Error('Invalid asset');
		}
		return result.data;
	}
	const response = await fetch(`/api/games/${encodeURIComponent(gameId)}/assets/${hash}`, {
		cache: 'force-cache'
	});
	if (!response.ok) {
		throw Error('Asset unavailable');
	}
	const blob = await response.blob();
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(Error('Asset unavailable'));
		reader.readAsDataURL(blob);
	});
}
export const storageRequest = synchronizedStorage(send, loadAsset);
