import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { createEditorDraft, editorContent } from '#lib/games/editor.js';
import { decodeGamePackage, encodeGamePackage } from '#lib/games/package/codec.js';
import { createGameRepository } from '#lib/games/repository-core.js';
import { CONFLICT } from '#lib/storage/protocol.js';
import { synchronizedStorage } from '#lib/storage/sync-client.js';

import { editorDraftStorage } from './editor-drafts.js';
import { openStorage } from './sqlite.js';
import { storageAsset, storageSync } from './storage-sync.js';

let directory: string;
let store: ReturnType<typeof openStorage>;
let repo: ReturnType<typeof createGameRepository>;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'helia-version-transport-'));
	store = openStorage(join(directory, 'game.sqlite'));
	repo = createGameRepository(
		synchronizedStorage(
			async (request) => structuredClone(storageSync(store, request)),
			async (gameId, hash) => {
				const asset = storageAsset(store, gameId, hash);
				if (!asset) {
					throw Error('Missing media');
				}
				return asset.data;
			}
		)
	);
});
afterEach(() => {
	store.close();
	rmSync(directory, { recursive: true, force: true });
});

it('freezes applied media through the real transport and preserves it across edits and restart', async () => {
	const game = await repo.createGame({ title: 'Applied', genre: '', description: '' });
	const oldMedia = 'data:image/png;base64,AQID';
	const applied = await repo.applyGameDraft(game.id, {
		baseContent: editorContent(game),
		content: {
			...editorContent(game),
			resources: { portrait: { name: 'images/portrait.png', mime: 'image/png', data: oldMedia } }
		}
	});
	const draft = createEditorDraft(applied);
	draft.documents.info = JSON.stringify({ title: 'Unapplied', genre: '', description: '' });
	editorDraftStorage(store.connection).write(game.id, draft, 0);
	const before = await repo.getGameVersioning(game.id);
	await repo.appendUserMessage(game.id, game.activeSessionId, 'Private player history');
	expect((await repo.getGameVersioning(game.id)).contentHash).toBe(before.contentHash);
	const result = await repo.createGameRelease(game.id, '1.0.0', {
		expectedContentHash: before.contentHash
	});
	if (result.kind !== 'released' || !result.state.currentRelease) {
		throw Error('Expected initial release');
	}
	const releaseId = result.state.currentRelease.id;
	const frozen = await repo.getGameRelease(game.id, releaseId);
	expect(frozen.content.title).toBe('Applied');
	expect(frozen.content.resources?.portrait.data).toBe(oldMedia);
	expect(JSON.stringify(frozen)).not.toContain('Private player history');
	await repo.applyGameDraft(game.id, {
		baseContent: editorContent(applied),
		content: {
			...editorContent(applied),
			resources: {
				portrait: { name: 'images/new.png', mime: 'image/png', data: 'data:image/png;base64,BAUG' }
			}
		}
	});
	store.close();
	store = openStorage(join(directory, 'game.sqlite'));
	expect(await repo.getGameRelease(game.id, releaseId)).toEqual(frozen);
	expect(await repo.getGameVersioning(game.id)).toMatchObject({
		modified: true,
		originalGameId: before.originalGameId,
		currentRelease: { id: releaseId, contentVersion: '1.0.0' }
	});
	expect(editorDraftStorage(store.connection).read(game.id).draft?.documents.info).toBe(
		draft.documents.info
	);
});

it('requires a fresh content confirmation to keep both variants of the same version', async () => {
	const game = await repo.createGame();
	const first = await repo.createGameRelease(game.id, '1.0.0');
	expect(first.kind).toBe('released');
	await repo.updateGame(game.id, { title: 'Changed', genre: '', description: '' });
	const conflict = await repo.createGameRelease(game.id, '1.0.0');
	if (conflict.kind !== 'conflict') {
		throw Error('Expected version conflict');
	}
	await repo.updateGame(game.id, { title: 'Changed again', genre: '', description: '' });
	await expect(
		repo.createGameRelease(game.id, '1.0.0', {
			ignoreConflict: true,
			expectedContentHash: conflict.incomingHash
		})
	).rejects.toThrow(CONFLICT);
	expect((await repo.getGameVersioning(game.id)).releases).toHaveLength(1);
	const next = await repo.createGameRelease(game.id, '1.0.0');
	if (next.kind !== 'conflict') {
		throw Error('Expected updated conflict');
	}
	const kept = await repo.createGameRelease(game.id, '1.0.0', {
		ignoreConflict: true,
		expectedContentHash: next.incomingHash
	});
	expect(kept.kind).toBe('released');
	const state = await repo.getGameVersioning(game.id);
	expect(state.releases).toHaveLength(2);
	expect(new Set(state.releases.map((release) => release.contentHash)).size).toBe(2);
	expect(state.modified).toBe(false);
	expect((await repo.createGameRelease(game.id, '1.0.0')).kind).toBe('released');
	expect((await repo.getGameVersioning(game.id)).releases).toHaveLength(2);
});

function manyResources(count: number) {
	return Object.fromEntries(
		Array.from({ length: count }, (_, index) => [
			`asset-${index}`,
			{
				name: `images/asset-${index}.png`,
				mime: 'image/png',
				data: 'data:image/png;base64,AA=='
			}
		])
	);
}

it.each([129, 257])(
	'saves, drafts, releases and exports %i small resources through the real transport',
	async (count) => {
		const game = await repo.createGame({ title: 'Many assets', genre: '', description: '' });
		const base = editorContent(game);
		const resources = manyResources(count);
		const applied = await repo.applyGameDraft(game.id, {
			baseContent: base,
			content: { ...base, resources }
		});
		expect(Object.keys(applied.resources ?? {})).toHaveLength(count);

		const draft = createEditorDraft(applied);
		editorDraftStorage(store.connection).write(game.id, draft, 0);
		expect(editorDraftStorage(store.connection).read(game.id).draft?.documents.assets).toBe(
			draft.documents.assets
		);

		const result = await repo.createGameRelease(game.id, '1.0.0');
		if (result.kind !== 'released' || !result.state.currentRelease) {
			throw Error('Expected release');
		}
		const frozen = await repo.getGameRelease(game.id, result.state.currentRelease.id);
		expect(Object.keys(frozen.content.resources ?? {})).toHaveLength(count);

		const bytes = await encodeGamePackage({ ...frozen });
		const decoded = await decodeGamePackage(bytes);
		expect(Object.keys(decoded.content.resources ?? {})).toHaveLength(count);
		expect(decoded.content.resources).toEqual(frozen.content.resources);
	}
);
