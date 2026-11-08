import {
	credentialRecord,
	type CatalogModel,
	type CredentialValue
} from '#lib/app/settings/credential-protocol.js';

function catalogRequest(credential: CredentialValue, apiKey: string, cursor: string) {
	const google = isGoogle(credential);
	const url = new URL(`${credential.baseUrl}/models`);
	const headers: Record<string, string> = { accept: 'application/json' };
	if (google) {
		headers['x-goog-api-key'] = apiKey;
		url.searchParams.set('pageSize', '1000');
		if (cursor) {
			url.searchParams.set('pageToken', cursor);
		}
	} else if (credential.kind === 'anthropic') {
		headers['x-api-key'] = apiKey;
		headers['anthropic-version'] = '2023-06-01';
		url.searchParams.set('limit', '1000');
		if (cursor) {
			url.searchParams.set('after_id', cursor);
		}
	} else {
		headers.authorization = `Bearer ${apiKey}`;
	}

	return { url, headers };
}
function isGoogle(credential: CredentialValue) {
	return credential.kind === 'google' || credential.kind === 'google-interactions';
}
async function readCatalogResponse(response: Response): Promise<Record<string, unknown>> {
	const reader = response.body?.getReader();
	if (!reader) {
		throw new Error('모델 목록 응답이 비어 있어요.');
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
			if (size > 8 * 1024 * 1024) {
				throw new Error('response limit');
			}
			chunks.push(value);
		}
	} catch {
		await reader.cancel().catch(() => {});
		throw new Error('모델 목록 응답이 너무 크거나 전송이 중단됐어요.');
	}
	let payload: Record<string, unknown>;
	try {
		payload = credentialRecord(JSON.parse(Buffer.concat(chunks).toString('utf8')));
	} catch {
		throw new Error('서비스가 올바른 모델 목록을 반환하지 않았어요.');
	}

	return payload;
}
function parseCatalogModel(value: unknown, google: boolean, apiKey: string): CatalogModel | null {
	const entry = credentialRecord(value);
	if (
		google &&
		Array.isArray(entry.supportedGenerationMethods) &&
		!entry.supportedGenerationMethods.includes('generateContent')
	) {
		return null;
	}
	const id =
		google && typeof entry.name === 'string' ? entry.name.replace(/^models\//, '') : entry.id;
	if (typeof id !== 'string' || !id || id.length > 256 || /\p{Cc}/u.test(id)) {
		throw new Error('서비스가 올바른 모델 ID를 반환하지 않았어요.');
	}
	const name = String(entry.displayName ?? entry.display_name ?? entry.name ?? id).slice(0, 120);
	const model: CatalogModel = {
		id,
		name,
		...(typeof entry.description === 'string'
			? { description: entry.description.slice(0, 500) }
			: {})
	};
	if ([model.id, model.name, model.description ?? ''].some((text) => text.includes(apiKey))) {
		throw new Error('서비스의 모델 목록을 안전하게 표시할 수 없어요.');
	}
	return model;
}
function nextPage(payload: Record<string, unknown>, credential: CredentialValue): unknown {
	if (isGoogle(credential)) {
		return payload.nextPageToken;
	}
	if (credential.kind === 'anthropic' && payload.has_more === true) {
		return payload.last_id;
	}
	return undefined;
}
async function fetchCatalog(url: URL, options: RequestInit, send: typeof fetch) {
	let response: Response;
	try {
		response = await send(url, options);
	} catch {
		throw new Error('모델 목록 요청이 중단됐거나 서비스에 연결하지 못했어요.');
	}
	if (!response.ok) {
		throw new Error(
			response.status === 401 || response.status === 403
				? 'API 키와 모델 목록 조회 권한을 확인해주세요.'
				: '모델 목록을 불러오지 못했어요. 잠시 후 다시 시도해주세요.'
		);
	}
	return readCatalogResponse(response);
}
function readNextCursor(
	payload: Record<string, unknown>,
	credential: CredentialValue,
	cursor: string
): string | undefined {
	const next = nextPage(payload, credential);
	if (next === undefined || next === null || next === '') {
		if (credential.kind === 'anthropic' && payload.has_more === true) {
			throw new Error('모델 목록의 다음 페이지를 읽을 수 없어요.');
		}
		return undefined;
	}
	if (typeof next !== 'string' || next === cursor || next.length > 2048) {
		throw new Error('모델 목록의 다음 페이지를 읽을 수 없어요.');
	}
	return next;
}

function appendModels(
	result: Map<string, CatalogModel>,
	payload: Record<string, unknown>,
	google: boolean,
	apiKey: string
) {
	const entries = google ? payload.models : payload.data;
	if (!Array.isArray(entries)) {
		throw new Error('서비스가 올바른 모델 목록을 반환하지 않았어요.');
	}
	for (const value of entries) {
		const model = parseCatalogModel(value, google, apiKey);
		if (!model) {
			continue;
		}
		result.set(model.id, model);
		if (result.size > 10000) {
			throw new Error('모델 목록이 너무 커요. 모델 ID로 직접 추가해주세요.');
		}
	}
}

export async function discoverModels(
	credential: CredentialValue,
	signal?: AbortSignal,
	send: typeof fetch = fetch
): Promise<CatalogModel[]> {
	if (credential.kind === 'google-vertex') {
		throw new Error('Vertex AI에서는 모델 ID를 직접 추가해주세요.');
	}
	const apiKey = credential.apiKey;
	if (!apiKey) {
		throw new Error('API 키를 먼저 저장해주세요.');
	}
	const google = isGoogle(credential),
		result = new Map<string, CatalogModel>();
	let cursor = '';
	const abort = AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]);
	for (let page = 0; page < 20; page++) {
		const { url, headers } = catalogRequest(credential, apiKey, cursor);
		const payload = await fetchCatalog(url, { headers, redirect: 'error', signal: abort }, send);
		appendModels(result, payload, google, apiKey);
		const next = readNextCursor(payload, credential, cursor);
		if (next === undefined) {
			return [...result.values()];
		}
		cursor = next;
	}
	throw new Error('모델 목록 페이지가 너무 많아요. 모델 ID로 직접 추가해주세요.');
}
