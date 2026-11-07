import { validateStateKey } from './state/value.js';

export interface GameResource {
	name: string;
	mime: string;
	data: string;
}
export type GameResources = Record<string, GameResource>;
export const RESOURCE_LIMITS = { fileBytes: 1024 * 1024, totalBytes: 3 * 1024 * 1024 } as const;
const media = new Set([
	'image/png',
	'image/jpeg',
	'image/webp',
	'image/gif',
	'audio/mpeg',
	'audio/wav',
	'audio/ogg',
	'video/mp4',
	'video/webm'
]);

/** Only portable, inert media may be embedded; SVG/HTML and network URLs are excluded. */
export function parseResources(value: unknown): GameResources {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw Error('리소스 목록의 형식을 확인해주세요.');
	const entries = Object.entries(value);
	if (entries.length > 128) throw Error('리소스는 128개까지 추가할 수 있어요.');
	const result: GameResources = {};
	let total = 0;
	for (const [id, input] of entries) {
		validateStateKey(id);
		if (!/^[\w.-]{1,100}$/.test(id) || !input || typeof input !== 'object' || Array.isArray(input))
			throw Error('리소스 식별자를 확인해주세요.');
		const row = input as Record<string, unknown>;
		if (
			typeof row.name !== 'string' ||
			!row.name.trim() ||
			row.name.length > 200 ||
			typeof row.mime !== 'string' ||
			!media.has(row.mime) ||
			typeof row.data !== 'string'
		)
			throw Error('지원하는 이미지·오디오·비디오 파일을 선택해주세요.');
		const prefix = `data:${row.mime};base64,`;
		const data = row.data.startsWith(prefix) ? row.data.slice(prefix.length) : '';
		if (
			!data ||
			data.length % 4 !== 0 ||
			!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
		)
			throw Error('리소스 파일 데이터가 올바르지 않아요.');
		const bytes = (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
		total += bytes;
		if (bytes > RESOURCE_LIMITS.fileBytes || total > RESOURCE_LIMITS.totalBytes)
			throw Error('리소스는 파일당 1 MiB, 전체 3 MiB까지 저장할 수 있어요.');
		result[id] = { name: row.name, mime: row.mime, data: row.data };
	}
	return result;
}
