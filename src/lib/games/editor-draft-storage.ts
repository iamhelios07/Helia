import { isDesktopBuild } from '#lib/platform/index.js';
import { readEditorDraft, type EditorDraft } from './editor.js';

export interface SavedEditorDraft {
	version: number;
	draft: EditorDraft | null;
}
function parseSaved(value: unknown, gameId: string): SavedEditorDraft {
	if (!value || typeof value !== 'object') throw Error('잘못된 편집 초안 응답이에요.');
	const row = value as Record<string, unknown>;
	if (typeof row.version !== 'number' || !Number.isSafeInteger(row.version) || row.version < 0)
		throw Error('잘못된 편집 초안 리비전이에요.');
	return {
		version: row.version,
		draft: row.draft === null ? null : readEditorDraft(JSON.stringify(row.draft), gameId)
	};
}
const key = (id: string) => 'helia:authoring:' + id;
async function nativeDraftRequest(gameId: string, request: unknown): Promise<SavedEditorDraft> {
	const host: unknown = Reflect.get(window, '__HELIA_STORAGE__');
	if (window !== window.top || typeof host !== 'function')
		throw Error('데스크톱 초안 저장소는 Helia 앱에서 사용할 수 있어요.');
	return parseSaved(await host(request), gameId);
}
export async function loadAuthoringDraft(gameId: string): Promise<SavedEditorDraft> {
	if (isDesktopBuild) {
		const current = await nativeDraftRequest(gameId, { kind: 'readDraft', gameId });
		if (current.version === 0) {
			let old: string | null = null;
			try {
				old = localStorage.getItem(key(gameId));
			} catch {
				/* Optional legacy cache. */
			}
			if (old) {
				const previous = parseSaved(JSON.parse(old), gameId);
				const saved = await nativeDraftRequest(gameId, {
					kind: 'writeDraft',
					gameId,
					version: 0,
					draft: previous.draft
				});
				try {
					localStorage.removeItem(key(gameId));
				} catch {
					/* The durable revision prevents replay. */
				}
				return saved;
			}
		}
		return current;
	}
	const response = await fetch('/api/games/' + encodeURIComponent(gameId) + '/draft', {
		cache: 'no-store'
	});
	if (!response.ok) throw Error('서버의 편집 초안을 불러오지 못했어요. 로컬 복구본은 유지됩니다.');
	return parseSaved(await response.json(), gameId);
}
export async function saveAuthoringDraft(
	gameId: string,
	draft: EditorDraft | null,
	version: number
): Promise<SavedEditorDraft> {
	if (isDesktopBuild) {
		return nativeDraftRequest(gameId, { kind: 'writeDraft', gameId, version, draft });
	}
	const response = await fetch('/api/games/' + encodeURIComponent(gameId) + '/draft', {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ version, draft })
	});
	const result: unknown = await response.json();
	if (!response.ok)
		throw Error(
			result && typeof result === 'object' && 'error' in result && typeof result.error === 'string'
				? result.error
				: '서버에 초안을 저장하지 못했어요.'
		);
	return parseSaved(result, gameId);
}
