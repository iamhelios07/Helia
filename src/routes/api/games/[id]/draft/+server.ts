import { json } from '@sveltejs/kit';

import type { DocumentClaim } from '#lib/server/media-uploads.js';

import { GAME_EDIT_LOCKED } from '#lib/games/edit-lock.js';
import { readEditorDraft } from '#lib/games/editor.js';
import { GamePackageError } from '#lib/games/package/limits.js';
import { ResourceListBudgetError } from '#lib/games/resources.js';
import { DOCUMENT_OPERATION_LIMITS } from '#lib/games/versioning-validation.js';
import { editorDraftStorage } from '#lib/server/editor-drafts.js';
import { serverStorage } from '#lib/server/sqlite.js';

import type { RequestHandler } from './$types';

const options = { headers: { 'cache-control': 'no-store' } };
// The draftSave operation budget replaces the old web body guard (§3.9); large bodies arrive as uploads.
const DRAFT_SAVE_BYTES = Number(DOCUMENT_OPERATION_LIMITS.draftSave);
export const GET: RequestHandler = ({ params }) => {
	try {
		return json(editorDraftStorage(serverStorage().connection).read(params.id), options);
	} catch {
		return json({ error: '편집 초안을 불러오지 못했어요.' }, { status: 400, ...options });
	}
};
function parseBody(text: string): Record<string, unknown> {
	if (text.length > DRAFT_SAVE_BYTES) {
		throw Error('저장할 내용이 너무 커요');
	}
	const value: unknown = JSON.parse(text);
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw Error('Invalid draft');
	}
	return value as Record<string, unknown>;
}
export const PUT: RequestHandler = async ({ request, params, url }) => {
	if (
		request.headers.get('origin') !== (process.env.HELIA_ORIGIN ?? url.origin) ||
		!request.headers.get('content-type')?.startsWith('application/json')
	) {
		return json({ error: '허용하지 않는 요청이에요.' }, { status: 403, ...options });
	}
	try {
		const store = serverStorage();
		let input = parseBody(await request.text());
		let claim: DocumentClaim | undefined;
		if ('bodyRef' in input) {
			const doc = store.uploads.document(params.id, input.bodyRef, 'draftSave');
			const resolved = parseBody(doc.text);
			if (resolved.kind !== 'writeDraft' || resolved.gameId !== params.id) {
				throw Error('Invalid draft');
			}
			input = resolved;
			claim = doc.claim;
		}
		if (
			typeof input.version !== 'number' ||
			!Number.isSafeInteger(input.version) ||
			!Object.hasOwn(input, 'draft')
		) {
			throw Error('Invalid draft');
		}
		const draft =
			input.draft === null
				? null
				: readEditorDraft(JSON.stringify(input.draft), params.id, { write: true });
		const version = input.version;
		const write = () => editorDraftStorage(store.connection).write(params.id, draft, version);
		// Consume the document in the same transaction as the draft write so a failed save keeps it.
		const saved = claim
			? store.connection
					.transaction(() => {
						const result = write();
						store.uploads.consumeDocument(claim);
						return result;
					})
					.immediate()
			: write();
		return json(saved, options);
	} catch (error) {
		return draftFailure(error);
	}
};

function draftFailure(error: unknown): Response {
	if (
		error instanceof ResourceListBudgetError ||
		(error instanceof Error && error.message === '저장할 내용이 너무 커요')
	) {
		return json({ error: error.message }, { status: 400, ...options });
	}
	if (error instanceof GamePackageError) {
		return json({ error: error.message, errorCode: error.code }, { status: 400, ...options });
	}
	if (error instanceof Error && error.message === GAME_EDIT_LOCKED) {
		return json(
			{ error: GAME_EDIT_LOCKED, errorCode: GAME_EDIT_LOCKED },
			{ status: 403, ...options }
		);
	}
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
