import { json } from '@sveltejs/kit';
import { serverStorage } from '#lib/server/sqlite.js';
import { editorDraftStorage } from '#lib/server/editor-drafts.js';
import { readEditorDraft } from '#lib/games/editor.js';
import type { RequestHandler } from './$types';

const options = { headers: { 'cache-control': 'no-store' } };
export const GET: RequestHandler = ({ params }) => {
	try {
		return json(editorDraftStorage(serverStorage().connection).read(params.id), options);
	} catch {
		return json({ error: '편집 초안을 불러오지 못했어요.' }, { status: 400, ...options });
	}
};
export const PUT: RequestHandler = async ({ request, params, url }) => {
	if (
		request.headers.get('origin') !== (process.env.HELIA_ORIGIN ?? url.origin) ||
		!request.headers.get('content-type')?.startsWith('application/json')
	)
		return json({ error: '허용하지 않는 요청이에요.' }, { status: 403, ...options });
	try {
		const text = await request.text();
		if (text.length > 20 * 1024 * 1024) throw Error('초안이 너무 커요.');
		const input = JSON.parse(text) as { version?: unknown; draft?: unknown };
		if (
			typeof input.version !== 'number' ||
			!Number.isSafeInteger(input.version) ||
			!Object.hasOwn(input, 'draft')
		)
			throw Error('Invalid draft');
		const draft =
			input.draft === null ? null : readEditorDraft(JSON.stringify(input.draft), params.id);
		return json(
			editorDraftStorage(serverStorage().connection).write(params.id, draft, input.version),
			options
		);
	} catch (error) {
		const conflict = error instanceof Error && error.message === 'EDITOR_DRAFT_CONFLICT';
		return json(
			{
				error: conflict
					? '다른 편집기에서 초안이 변경되었어요. 입력 내용을 보존한 뒤 초안을 다시 불러와주세요.'
					: '편집 초안을 저장하지 못했어요.'
			},
			{ status: conflict ? 409 : 400, ...options }
		);
	}
};
