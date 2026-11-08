import { validateStateKey } from './state/value.js';

export interface GameResource {
	name: string;
	mime: string;
	data: string;
}
export type GameResources = Record<string, GameResource>;
export const RESOURCE_LIMITS = { fileBytes: 1024 * 1024, totalBytes: 3 * 1024 * 1024 } as const;
export function validateResourcePath(path: string): void {
	if (
		!path ||
		path.length > 200 ||
		/[\\:]/.test(path) ||
		Array.from(path).some(
			(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
		) ||
		path.split('/').some((part) => !part.trim() || part === '.' || part === '..')
	)
		throw Error('파일 경로는 비어 있지 않은 상대 경로여야 해요.');
}

/** Rename a directory without changing any resource identity or embedded bytes. */
export function renameResourceFolder(
	resources: GameResources,
	from: string,
	to: string
): GameResources {
	validateResourcePath(from);
	validateResourcePath(to);
	return parseResources(
		Object.fromEntries(
			Object.entries(resources).map(([id, asset]) => [
				id,
				{
					...asset,
					name: asset.name.startsWith(from + '/') ? to + asset.name.slice(from.length) : asset.name
				}
			])
		)
	);
}
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
	const paths = new Set<string>();
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
		validateResourcePath(row.name);
		if (paths.has(row.name)) throw Error('같은 경로의 파일이 이미 있어요.');
		paths.add(row.name);
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
	for (const path of paths) {
		const parts = path.split('/');
		for (let i = 1; i < parts.length; i++) {
			if (paths.has(parts.slice(0, i).join('/')))
				throw Error('파일과 폴더가 같은 경로를 사용할 수 없어요.');
		}
	}
	for (const [id, resource] of Object.entries(result)) {
		if (Object.hasOwn(result, resource.name) && resource.name !== id)
			throw Error('파일 경로가 다른 에셋의 참조와 겹쳐요.');
	}
	return result;
}
