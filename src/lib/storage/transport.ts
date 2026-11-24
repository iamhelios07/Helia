import {
	checkPackageSize,
	GamePackageError,
	isGamePackageErrorCode
} from '#lib/games/package/limits.js';
import { isDesktopBuild, isTauri } from '#lib/platform/index.js';

import installRequestLimit from './install-request-limit.json';
import { synchronizedStorage } from './sync-client.js';

function packageError(error: unknown): GamePackageError | undefined {
	if (
		typeof error === 'object' &&
		error !== null &&
		'errorCode' in error &&
		isGamePackageErrorCode(error.errorCode)
	) {
		return new GamePackageError(error.errorCode);
	}
}

async function sendNative(request: unknown): Promise<unknown> {
	if (!isTauri()) {
		throw new Error('데스크톱 저장소는 Helia 앱에서 사용할 수 있어요.');
	}
	const host: unknown = Reflect.get(window, '__HELIA_STORAGE__');
	if (window !== window.top || typeof host !== 'function') {
		throw new Error('데스크톱 저장소 접근이 허용되지 않았어요.');
	}
	let nativeRequest = request;
	if (
		typeof request === 'object' &&
		request !== null &&
		'kind' in request &&
		request.kind === 'install'
	) {
		// v1: content (16 MiB) + ceil(assets (24 MiB) * 4/3) + 여유분 = 64 MiB.
		// 앱 리소스 한도(1 MiB/3 MiB)를 없애면 재검토. 웹 본문 한도는 별도다.
		const json = JSON.stringify(request);
		checkPackageSize(new TextEncoder().encode(json).length, installRequestLimit);
		// B1 normally rejects invalid UTF-16 first. Raw JSON lets Rust also reject it defensively.
		nativeRequest = { kind: 'installJson', json };
	}
	try {
		return await host(nativeRequest);
	} catch (error) {
		throw packageError(error) ?? error;
	}
}

async function send(request: unknown): Promise<unknown> {
	if (isDesktopBuild) {
		return sendNative(request);
	}
	const response = await fetch('/api/storage', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(request)
	});
	const result: unknown = await response.json().catch(() => null);
	if (!response.ok) {
		const failure = response.status === 400 ? packageError(result) : undefined;
		if (failure) {
			throw failure;
		}
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
