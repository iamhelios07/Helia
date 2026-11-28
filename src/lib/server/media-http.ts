import { json } from '@sveltejs/kit';

import { GamePackageError, requirePackage } from '#lib/games/package/limits.js';

import { uploadError } from './media-uploads.js';

export async function uploadResponse(request: Request, url: URL, work: () => unknown) {
	const headers = new Headers({ 'cache-control': 'no-store' });
	try {
		if (request.method !== 'GET') {
			requirePackage(request.headers.get('origin') === (process.env.HELIA_ORIGIN ?? url.origin));
		}
		return json(await work(), { headers });
	} catch (error) {
		const { code } = uploadError(error);
		if (code === 'busy') {
			headers.set('retry-after', '1');
		}
		const statuses: Partial<Record<typeof code, number>> = { busy: 503, requestLimit: 413 };
		return json({ errorCode: code }, { headers, status: statuses[code] ?? 400 });
	}
}
export async function readBytes(request: Request, limit: number) {
	const reader = request.body?.getReader();
	requirePackage(reader, 'chunkInvalid');
	const buffer = Buffer.alloc(limit);
	let offset = 0;
	let idle = false;
	// Cancelling settles the pending read even if the underlying transport is slow to close.
	const stop = () => void reader.cancel().catch(() => {});
	const timer = setTimeout(() => {
		idle = true;
		stop();
	}, 30000);
	try {
		for (;;) {
			const { done, value } = await reader.read();
			requirePackage(!idle, 'chunkInvalid');
			if (done) {
				return buffer.subarray(0, offset);
			}
			requirePackage(value.length <= limit - offset, 'chunkInvalid');
			buffer.set(value, offset);
			offset += value.length;
			if (value.length) {
				timer.refresh();
			}
		}
	} finally {
		clearTimeout(timer);
		stop();
		reader.releaseLock();
	}
}
export async function metadata(request: Request): Promise<Record<string, unknown>> {
	if (!request.body) {
		return {};
	}
	const raw = await readBytes(request, 8192);
	const data: unknown = JSON.parse(raw.toString('utf8'));
	if (!data || typeof data !== 'object' || Array.isArray(data)) {
		throw new GamePackageError('format');
	}
	return data as Record<string, unknown>;
}
