import {
	checkPackageSize,
	GamePackageError,
	isGamePackageErrorCode,
	SAVE_BODY_REF_BYTES
} from '#lib/games/package/limits.js';
import { ResourceListBudgetError, validateResourceListBudget } from '#lib/games/resources.js';
import { validateDocumentOperationBytes } from '#lib/games/versioning-validation.js';
import { isDesktopBuild, isTauri } from '#lib/platform/index.js';

import installRequestLimit from './install-request-limit.json';
import { uploadDocumentBody } from './media-transfer.js';
import { synchronizedStorage } from './sync-client.js';

function storageError(error: unknown): Error | undefined {
	const message = typeof error === 'string' ? error : field(error, 'error');
	if (typeof message === 'string' && message.startsWith('리소스 목록이 너무 커요(')) {
		return new ResourceListBudgetError(message);
	}
	if (
		typeof error === 'object' &&
		error !== null &&
		'errorCode' in error &&
		isGamePackageErrorCode(error.errorCode)
	) {
		return new GamePackageError(error.errorCode);
	}
}

export async function sendNative(request: unknown): Promise<unknown> {
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
		throw storageError(error) ?? error;
	}
}

function field(value: unknown, key: string): unknown {
	return value && typeof value === 'object' ? Reflect.get(value, key) : undefined;
}

/** Serializes a write request, splitting an oversized command into a document upload (§3.9). */
async function prepareWriteRequest(request: unknown): Promise<{ body: string; native: unknown }> {
	const envelope = field(request, 'kind') === 'sync' ? field(request, 'request') : request;
	const kind = field(envelope, 'kind');
	if (kind === 'commit' || kind === 'create') {
		checkResourceRecords(envelope);
	}
	// A new game has no writable upload scope yet; create keeps the host's inline checks.
	if (kind === 'commit') {
		const text = JSON.stringify(envelope);
		const bytes = BigInt(new TextEncoder().encode(text).length);
		if (bytes > SAVE_BODY_REF_BYTES) {
			// Only the operation budget rejects a save; the host revalidates the uploaded body.
			validateDocumentOperationBytes('commit', bytes);
			const gameId = field(envelope, 'gameId');
			const bodyRef = await uploadDocumentBody(String(gameId), 'commit', text);
			const stub = { kind, gameId, bodyRef };
			const split =
				field(request, 'kind') === 'sync' ? { ...record(request), request: stub } : stub;
			return { body: JSON.stringify(split), native: split };
		}
	}
	if (kind === 'install' || kind === 'installPreview') {
		validateResourceListBudget(
			field(field(field(envelope, 'release'), 'content'), 'resources') ?? {}
		);
	}
	return { body: JSON.stringify(request), native: request };
}
function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function checkResourceRecords(command: unknown) {
	const records = field(command, 'records');
	for (const row of Array.isArray(records) ? records : []) {
		if (field(row, 'table') === 'games') {
			const resources =
				field(field(row, 'value'), 'resources') ??
				field(field(field(row, 'patch'), 'set'), 'resources');
			if (resources !== undefined) {
				validateResourceListBudget(resources);
			}
		}
	}
	const resources = field(field(field(command, 'gamePatch'), 'set'), 'resources');
	if (resources !== undefined) {
		validateResourceListBudget(resources);
	}
}

async function send(request: unknown): Promise<unknown> {
	const prepared = await prepareWriteRequest(request);
	if (isDesktopBuild) {
		return sendNative(prepared.native);
	}
	const response = await fetch('/api/storage', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: prepared.body
	});
	const result: unknown = await response.json().catch(() => null);
	if (!response.ok) {
		const failure = response.status === 400 ? storageError(result) : undefined;
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
		const result: unknown = await send({ kind: 'asset', gameId, hash });
		const data = field(result, 'data');
		if (typeof data !== 'string' || !data.startsWith('data:')) {
			throw Error('Invalid asset');
		}
		return data;
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
