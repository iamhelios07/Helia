import {
	GamePackageError,
	isGamePackageErrorCode,
	requirePackage
} from '#lib/games/package/limits.js';
import { Sha256 } from '#lib/games/state/sha256.js';
import { isDesktopBuild } from '#lib/platform/index.js';

import { Base64Stream } from './media-identity.js';
import {
	isMediaHash,
	MEDIA_CHUNK_SIZE,
	DOCUMENT_MIME,
	BODY_REF_PREFIX,
	type DocumentOperation,
	type DocumentUploadResult,
	type EditBlobResult
} from './media-protocol.js';
import { sendNative } from './transport.js';

class Busy extends GamePackageError {
	constructor(readonly wait: number) {
		super('busy');
	}
}
function retryAfter(value: string | null) {
	if (!value) {
		return 1000;
	}
	const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
	return Number.isFinite(ms) ? Math.max(100, ms) : 1000;
}
async function http(url: string, init: RequestInit): Promise<unknown> {
	const response = await fetch(url, init);
	if (response.status === 413) {
		throw new GamePackageError('requestLimit');
	}
	const result = await response.json();
	if (response.ok) {
		return result;
	}
	if (result?.errorCode === 'busy') {
		throw new Busy(retryAfter(response.headers.get('retry-after')));
	}
	if (isGamePackageErrorCode(result?.errorCode)) {
		throw new GamePackageError(result.errorCode);
	}
	throw new Error('업로드 요청에 실패했어요.');
}
interface UploadOptions {
	mime?: string;
	label?: string;
	sha256?: string;
	signal?: AbortSignal;
}
type Options = UploadOptions &
	({ purpose: 'edit' } | { purpose: 'document'; operation: DocumentOperation });
async function chunkHash(buffer: ArrayBuffer) {
	if (!globalThis.crypto?.subtle) {
		// WebCrypto is unavailable on non-local HTTP origins. Still hash just one chunk.
		return new Sha256().update(new Uint8Array(buffer)).digest();
	}
	const digest = await crypto.subtle.digest('SHA-256', buffer);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
class Transfer {
	id?: string;
	readonly controller = new AbortController();
	readonly url: string;
	constructor(
		readonly gameId: string,
		readonly file: Blob,
		readonly options: Options
	) {
		this.url = `/api/games/${encodeURIComponent(gameId)}/uploads`;
	}
	get sessionUrl() {
		return `${this.url}/${encodeURIComponent(this.id!)}`;
	}
	get purpose() {
		return this.options.purpose;
	}
	async begin() {
		const payload = {
			purpose: this.purpose,
			mime: this.options.mime ?? this.file.type,
			size: this.file.size,
			label: this.options.label,
			sha256: this.options.sha256,
			...(this.options.purpose === 'document' ? { operation: this.options.operation } : {})
		};
		const result = isDesktopBuild
			? await sendNative({ kind: 'mediaUploadBegin', gameId: this.gameId, ...payload })
			: await http(this.url, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(payload),
					signal: this.controller.signal
				});
		const r = fields(result);
		requirePackage(typeof r.uploadId === 'string' && r.uploadId.length > 0);
		this.id = r.uploadId;
		requirePackage(
			r.chunkSize === MEDIA_CHUNK_SIZE &&
				r.chunkCount === Math.ceil(this.file.size / MEDIA_CHUNK_SIZE)
		);
		return r.chunkCount as number;
	}
	async chunk(index: number) {
		const start = index * MEDIA_CHUNK_SIZE;
		const buffer = await this.file.slice(start, start + MEDIA_CHUNK_SIZE).arrayBuffer();
		const bytes = new Uint8Array(buffer);
		const sha256 = await chunkHash(buffer);
		const signal = this.controller.signal;
		let data = '';
		if (isDesktopBuild) {
			const encoder = new Base64Stream((part) => {
				data += part;
			});
			encoder.update(bytes);
			encoder.finish();
		}
		await retry(async () => {
			const reply = isDesktopBuild
				? await sendNative({
						kind: 'mediaUploadChunk',
						gameId: this.gameId,
						uploadId: this.id,
						index,
						sha256,
						data
					})
				: await http(`${this.sessionUrl}/chunks/${index}`, {
						method: 'PUT',
						headers: { 'content-type': 'application/octet-stream', 'x-helia-chunk-sha256': sha256 },
						body: buffer,
						signal
					});
			requirePackage(fields(reply).received === index);
		}, signal);
	}
	async finish(): Promise<EditBlobResult | DocumentUploadResult> {
		const signal = this.controller.signal;
		const result = await retry(
			() =>
				isDesktopBuild
					? sendNative({ kind: 'mediaUploadFinish', gameId: this.gameId, uploadId: this.id })
					: http(`${this.sessionUrl}/finish`, {
							method: 'POST',
							body: '{}',
							headers: { 'content-type': 'application/json' },
							signal
						}),
			signal,
			Date.now() + 3600000
		);
		const r = fields(result);
		requirePackage(r.size === this.file.size && r.mime === (this.options.mime ?? this.file.type));
		requirePackage(isMediaHash(r.sha256));
		if (this.purpose === 'document') {
			requirePackage(
				r.kind === 'upload' && r.ref === `${BODY_REF_PREFIX}${this.id}` && r.mime === DOCUMENT_MIME
			);
			requirePackage(typeof r.crc32 === 'number' && Number.isSafeInteger(r.crc32) && r.crc32 >= 0);
			return {
				kind: 'upload',
				ref: r.ref,
				sha256: r.sha256,
				size: r.size,
				mime: r.mime,
				crc32: r.crc32
			};
		}
		requirePackage(r.kind === 'blob' && isMediaHash(r.assetHash) && isMediaHash(r.blobId));
		return {
			kind: 'blob',
			assetHash: r.assetHash,
			blobId: r.blobId,
			sha256: r.sha256,
			size: r.size,
			mime: r.mime
		};
	}
	private cancelSent = false;
	cancel() {
		if (!this.id || this.cancelSent) {
			return;
		}
		this.cancelSent = true;
		const pending = isDesktopBuild
			? sendNative({ kind: 'mediaUploadCancel', gameId: this.gameId, uploadId: this.id })
			: http(this.sessionUrl, { method: 'DELETE', keepalive: true });
		void pending.catch(() => {});
	}
}
function fields(value: unknown): Record<string, unknown> {
	requirePackage(value && typeof value === 'object');
	return value as Record<string, unknown>;
}
function delay(ms: number, signal: AbortSignal) {
	signal.throwIfAborted();
	return new Promise<void>((resolve, reject) => {
		const abort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', abort);
			resolve();
		}, ms);
		signal.addEventListener('abort', abort, { once: true });
	});
}
/** Only chunk transport failures spend a retry. Finish may recover its saved result for an hour. */
async function retry<T>(send: () => Promise<T>, signal: AbortSignal, until?: number): Promise<T> {
	let attempts = 0;
	for (;;) {
		signal.throwIfAborted();
		try {
			return await send();
		} catch (error) {
			signal.throwIfAborted();
			const ms = retryDelay(error, attempts, until);
			if (!(error instanceof GamePackageError)) {
				attempts++;
			}
			await delay(ms, signal);
		}
	}
}
function retryDelay(error: unknown, attempts: number, until?: number) {
	let ms = 250 * 2 ** Math.min(attempts, 5);
	if (error instanceof GamePackageError) {
		if (error.code !== 'busy' && !(until && error.code === 'inProgress')) {
			throw error;
		}
		ms = error instanceof Busy ? error.wait : 1000;
	} else if (!until && attempts >= 5) {
		throw error;
	}
	if (until && Date.now() + ms >= until) {
		throw error;
	}
	return ms;
}

// A slot is handed directly to the oldest queued worker. No chunk bytes exist before admission.
let slots = 4;
const waiters: Array<() => void> = [];
async function sendPart(t: Transfer, index: number) {
	if (slots) {
		slots--;
	} else {
		await new Promise<void>((resolve) => waiters.push(resolve));
	}
	try {
		t.controller.signal.throwIfAborted();
		await t.chunk(index);
	} finally {
		const next = waiters.shift();
		if (next) {
			next();
		} else {
			slots++;
		}
	}
}
async function sendFile(t: Transfer) {
	const count = await t.begin();
	const signal = t.controller.signal;
	signal.throwIfAborted();
	let next = 0;
	const worker = async () => {
		while (next < count) {
			signal.throwIfAborted();
			await sendPart(t, next++);
		}
	};
	await Promise.all([worker(), worker()]);
	signal.throwIfAborted();
	return t.finish();
}
/** No resume token is persisted. A new call always begins a fresh upload. */
async function runUpload(
	gameId: string,
	file: Blob,
	options: Options
): Promise<EditBlobResult | DocumentUploadResult> {
	options.signal?.throwIfAborted();
	const t = new Transfer(gameId, file, options);
	const abort = () => t.controller.abort(options.signal?.reason);
	const fail = new Promise<never>((_, reject) =>
		t.controller.signal.addEventListener(
			'abort',
			() => {
				t.cancel();
				reject(t.controller.signal.reason);
			},
			{ once: true }
		)
	);
	options.signal?.addEventListener('abort', abort, { once: true });
	globalThis.addEventListener?.('pagehide', abort);
	try {
		// Native IPC cannot abort an in-flight Begin; cancel a late session once its ID arrives.
		const task = sendFile(t).catch((error) => {
			if (t.controller.signal.aborted) {
				t.cancel();
			}
			throw error;
		});
		return await Promise.race([task, fail]);
	} catch (error) {
		abort();
		throw error;
	} finally {
		options.signal?.removeEventListener('abort', abort);
		globalThis.removeEventListener?.('pagehide', abort);
	}
}
export async function uploadEditMedia(
	gameId: string,
	file: Blob,
	options: UploadOptions = {}
): Promise<EditBlobResult> {
	const result = await runUpload(gameId, file, { ...options, purpose: 'edit' });
	requirePackage(result.kind === 'blob');
	return result;
}
/** Uploads a serialized request body as a `document` session and returns its `helia-upload:` ref. */
export async function uploadDocumentBody(
	gameId: string,
	operation: DocumentOperation,
	text: string,
	signal?: AbortSignal
): Promise<string> {
	const file = new Blob([text], { type: DOCUMENT_MIME });
	const result = await runUpload(gameId, file, {
		purpose: 'document',
		operation,
		mime: DOCUMENT_MIME,
		signal
	});
	if (result.kind !== 'upload') {
		throw new GamePackageError('format');
	}
	return result.ref;
}
