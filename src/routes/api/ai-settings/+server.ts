import { json } from '@sveltejs/kit';

import { parseAISettings, type AISettings } from '#lib/app/settings/model.js';
import { AI_SETTINGS_CONFLICT, aiSettingsStorage } from '#lib/server/ai-settings.js';
import { serverStorage } from '#lib/server/sqlite.js';

import type { RequestHandler } from './$types';

const MAX_BODY_BYTES = 1024 * 1024;
const headers = { 'cache-control': 'no-store' };
const failure = (message: string, status: number) => json({ error: message }, { status, headers });

function allowedOrigin(request: Request, url: URL, required: boolean): boolean {
	const origin = request.headers.get('origin');
	return (
		request.headers.get('sec-fetch-site') !== 'cross-site' &&
		((!required && origin === null) || origin === (process.env.HELIA_ORIGIN ?? url.origin))
	);
}

async function readBody(request: Request): Promise<unknown> {
	const reader = request.body?.getReader();
	if (!reader) {
		throw new Error('body');
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			size += value.byteLength;
			if (size > MAX_BODY_BYTES) {
				await reader.cancel();
				throw new Error('limit');
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readInput(request: Request, update: boolean) {
	const input: unknown = await readBody(request);
	if (!input || typeof input !== 'object' || Array.isArray(input) || !('settings' in input)) {
		throw new Error('input');
	}
	let revision = 0;
	if (update) {
		if (
			!('revision' in input) ||
			typeof input.revision !== 'number' ||
			!Number.isSafeInteger(input.revision) ||
			input.revision < 0
		) {
			throw new Error('revision');
		}
		revision = input.revision;
	}
	return { settings: parseAISettings(input.settings), revision };
}

export const GET: RequestHandler = ({ request, url }) => {
	if (!allowedOrigin(request, url, false)) {
		return failure('허용하지 않는 설정 요청이에요.', 403);
	}
	try {
		return json(aiSettingsStorage(serverStorage().connection).read(), { headers });
	} catch {
		return failure('AI 설정을 불러올 수 없어요.', 500);
	}
};

function writeHandler(update: boolean): RequestHandler {
	return async ({ request, url }) => {
		if (
			!allowedOrigin(request, url, true) ||
			request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
		) {
			return failure('허용하지 않는 설정 요청이에요.', 403);
		}
		let input: { settings: AISettings; revision: number };
		try {
			input = await readInput(request, update);
		} catch {
			return failure('설정 요청을 읽을 수 없어요. 설정 형식과 1MiB 크기 제한을 확인해주세요.', 400);
		}
		try {
			const storage = aiSettingsStorage(serverStorage().connection);
			return json(
				update ? storage.write(input.settings, input.revision) : storage.initialize(input.settings),
				{ headers }
			);
		} catch (error) {
			if (error instanceof Error && error.message === AI_SETTINGS_CONFLICT) {
				return failure(
					'다른 창에서 모델 설정이 변경됐어요. 설정을 다시 불러온 후 저장해주세요.',
					409
				);
			}
			return failure('AI 설정을 저장할 수 없어요.', 500);
		}
	};
}

export const POST = writeHandler(false);
export const PUT = writeHandler(true);
