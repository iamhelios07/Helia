import { afterAll, beforeAll, expect, it } from 'vitest';

import minimalRelease from '#lib/games/package/fixtures/minimal-release.json';
import { editorDraftStorage } from '#lib/server/editor-drafts.js';
import { openStorage } from '#lib/server/sqlite.js';
import { parseInstallRequest } from '#lib/storage/install.js';
import { parseRequest, storedRecord } from '#lib/storage/protocol.js';
import resourceListFixtures from '#lib/testing/fixtures/resource-list-r.json';

import { createEditorDraft, readEditorDraft, validateEditorDraftBudget } from './editor.js';
import { parseGame } from './model.js';
import { decodeGamePackage, encodeGamePackage } from './package/codec.js';
import {
	checkContentComplexity,
	checkSaveRequestSize,
	PACKAGE_LIMITS,
	parsePackageJson,
	SAVE_REQUEST_BYTES
} from './package/limits.js';
import { gameReleaseContent, hashGameReleaseContent } from './release-content.js';
import { createGameRepository } from './repository-core.js';
import {
	jsonUtf8Bytes,
	parseResources,
	RESOURCE_LIST_BYTES,
	resourceListBytes,
	validateResourceListBudget,
	type GameResources
} from './resources.js';
import {
	CONTENT_CHARACTER_LIMIT,
	CONTENT_NODE_LIMIT,
	DOCUMENT_OPERATION_LIMITS,
	parseGameRelease,
	validateDocumentOperationBytes,
	validateGameReleaseContent
} from './versioning-validation.js';

let resources: GameResources;
let last: string;
beforeAll(() => {
	const resource = {
		name: 'p'.repeat(80) + '000000',
		mime: 'image/png',
		data: 'data:image/png;base64,AA=='
	};
	const entryBytes = resourceListBytes({ r000000: resource }) - 1n;
	const count = Number((RESOURCE_LIST_BYTES - 1n) / entryBytes);
	resources = Object.fromEntries(
		Array.from({ length: count }, (_, index) => {
			const suffix = String(index).padStart(6, '0');
			return ['r' + suffix, { ...resource, name: 'p'.repeat(80) + suffix }];
		})
	);
	let remaining = Number(RESOURCE_LIST_BYTES - (1n + BigInt(count) * entryBytes));
	for (const id of Object.keys(resources).slice(-2)) {
		const added = Math.min(remaining, 200 - resources[id].name.length);
		resources[id].name += 'x'.repeat(added);
		remaining -= added;
	}
	expect(remaining).toBe(0);
	last = Object.keys(resources).at(-1)!;
});
afterAll(() => {
	resources = {};
});

it('measures canonical UTF-8 bytes with BigInt, including Unicode and JSON escapes', () => {
	const value = { 한: { name: '🌌', mime: 'image/png', data: '\0' } };
	expect(resourceListBytes(value)).toBe(jsonUtf8Bytes(value));
	expect(resourceListBytes(resources)).toBe(RESOURCE_LIST_BYTES);
});

it.each(resourceListFixtures)(
	'matches the shared host R fixture: $name',
	({ resources, expectedR }) => {
		expect(resourceListBytes(resources)).toBe(BigInt(expectedR));
	}
);

it('measures inline, package and stored references as the same stored metadata without mutation', () => {
	const resource = {
		name: 'images/한🌌.png',
		mime: 'image/png',
		data: 'helia-asset:' + 'a'.repeat(64)
	};
	const expected = resourceListBytes({ image: resource });
	for (const data of [
		'data:image/png;base64,AA==',
		'helia-package:assets/' + 'a'.repeat(64),
		resource.data
	]) {
		const value = { image: { ...resource, data } };
		expect(resourceListBytes(value)).toBe(expected);
		expect(value.image.data).toBe(data);
	}
});

it('accepts R exactly, rejects R+1, and keeps reads independent of the write budget', () => {
	expect(() => validateResourceListBudget(resources)).not.toThrow();
	expect(() => validateGameReleaseContent({ resources })).not.toThrow();
	resources[last].name += 'x';
	try {
		expect(resourceListBytes(resources)).toBe(RESOURCE_LIST_BYTES + 1n);
		expect(() => validateGameReleaseContent({ resources })).toThrow('리소스 목록이 너무 커요(항목');
		expect(() => validateGameReleaseContent({ resources }, { write: false })).not.toThrow();
		expect(Object.keys(parseResources(resources))).toHaveLength(Object.keys(resources).length);
	} finally {
		resources[last].name = resources[last].name.slice(0, -1);
	}
}, 30000);

it('exempts only root resources from ordinary node budgets and scans escaped root keys', () => {
	const bytes = new TextEncoder().encode(JSON.stringify({ resources }));
	expect(() => checkContentComplexity(bytes)).not.toThrow();
	const escapedKey = new TextEncoder().encode(
		JSON.stringify({ resources }).replace('"resources"', '"re\\u0073ources"')
	);
	expect(() => checkContentComplexity(escapedKey)).not.toThrow();
	expect(() => validateGameReleaseContent({ nested: { resources } })).toThrow();
	expect(() =>
		checkContentComplexity(new TextEncoder().encode(JSON.stringify({ nested: { resources } })))
	).toThrow();
}, 30000);

it('uses the same R boundary for package content.json despite its longer references', () => {
	const packaged = Object.fromEntries(
		Object.entries(resources).map(([id, value]) => [
			id,
			{ ...value, data: 'helia-package:assets/' + 'a'.repeat(64) }
		])
	);
	const bytes = new TextEncoder().encode(JSON.stringify({ resources: packaged }));
	expect(bytes.length).toBeLessThanOrEqual(PACKAGE_LIMITS.content);
	expect(resourceListBytes(packaged)).toBe(RESOURCE_LIST_BYTES);
	checkContentComplexity(bytes);
	expect(() => validateGameReleaseContent(parsePackageJson(bytes))).not.toThrow();
	packaged[last].name += 'x';
	expect(() => validateGameReleaseContent({ resources: packaged })).toThrow(
		'리소스 목록이 너무 커요'
	);
}, 30000);

it('round trips a v1 package at maximum R and rejects an oversized export', async () => {
	const content = gameReleaseContent(
		parseGame({
			...minimalRelease.content,
			resources,
			schemaVersion: 2,
			id: minimalRelease.originalGameId,
			activeSessionId: minimalRelease.originalGameId,
			createdAt: minimalRelease.createdAt,
			updatedAt: minimalRelease.createdAt
		})
	);
	const release = {
		...minimalRelease,
		content,
		contentHash: await hashGameReleaseContent(content)
	};
	const bytes = await encodeGamePackage(release);
	const decoded = await decodeGamePackage(bytes);
	expect(decoded.content.resources).toEqual(resources);
	expect(resourceListBytes(decoded.content.resources)).toBe(RESOURCE_LIST_BYTES);
	content.resources![last].name += 'x';
	await expect(encodeGamePackage(release)).rejects.toMatchObject({ code: 'limit' });
}, 60000);

it('normalizes extra resource fields before measuring host writes', async () => {
	const store = openStorage(':memory:');
	try {
		const game = await createGameRepository(async (request) => store.request(request)).createGame();
		const extra = resourceListFixtures.find(({ name }) => name === 'extra fields')!.resources;
		const value = {
			...game,
			resources: {
				...extra,
				image: {
					...extra.image,
					data: 'data:image/png;base64,AA==',
					extra: 'x'.repeat(Number(RESOURCE_LIST_BYTES)),
					number: 1e21
				}
			}
		};
		expect(() => validateResourceListBudget(value.resources)).toThrow();
		const request = {
			kind: 'commit',
			gameId: game.id,
			version: 0,
			deleteSessions: [],
			records: [{ table: 'games', id: game.id, gameId: game.id, sessionId: null, value }]
		};
		store.request(parseRequest(request));
		const saved = parseGame(store.request({ kind: 'read', gameId: game.id }).records[0].value);
		expect(resourceListBytes(saved.resources)).toBe(135n);
		expect(Object.keys(saved.resources!.image).sort()).toEqual(['data', 'mime', 'name']);
	} finally {
		store.close();
	}
});

it('preserves item validation when resources are excluded from general budgets', () => {
	const asset = { name: 'image.png', mime: 'image/png', data: 'helia-asset:' + 'a'.repeat(64) };
	for (const value of [
		{ ['a'.repeat(101)]: asset },
		{ image: { ...asset, name: 'x'.repeat(201) } },
		{ image: { ...asset, mime: 'image/svg+xml' } },
		{ image: { ...asset, data: 'helia-asset:invalid' } }
	]) {
		expect(() => validateGameReleaseContent({ resources: value })).toThrow();
	}
});

it('applies R to raw installation inputs before verification, retaining the budget message', () => {
	const request = {
		kind: 'install',
		packageFormatVersion: 1,
		gameId: '12345678-1234-4234-8234-123456789abd',
		sessionId: '12345678-1234-4234-8234-123456789abe',
		release: { ...minimalRelease, content: { ...minimalRelease.content, resources } }
	};
	expect(() => parseInstallRequest(request)).not.toThrow();
	resources[last].name += 'x';
	try {
		expect(() => parseInstallRequest(request)).toThrow('리소스 목록이 너무 커요');
	} finally {
		resources[last].name = resources[last].name.slice(0, -1);
	}
}, 30000);

it('counts keys and rejects an extra character while allowing escaped control values', () => {
	const key = 'k'.repeat(CONTENT_CHARACTER_LIMIT);
	expect(() => validateGameReleaseContent({ [key]: null })).not.toThrow();
	expect(() => validateGameReleaseContent({ [key + 'k']: null })).toThrow();
	const control = '\0'.repeat(CONTENT_CHARACTER_LIMIT - 1);
	expect(() => validateGameReleaseContent({ x: control })).not.toThrow();
	expect(jsonUtf8Bytes({ x: control })).toBeLessThanOrEqual(DOCUMENT_OPERATION_LIMITS.commit);
});

it('pins operation caps and accepts the boundary but rejects one extra byte', () => {
	expect(DOCUMENT_OPERATION_LIMITS.draftSave).toBe(134283264n);
	expect(DOCUMENT_OPERATION_LIMITS.commit).toBe(131872672n);
	expect(DOCUMENT_OPERATION_LIMITS.releaseCreate).toBe(DOCUMENT_OPERATION_LIMITS.commit);
	expect(CONTENT_NODE_LIMIT).toBe(100000);
	for (const operation of ['draftSave', 'commit', 'releaseCreate'] as const) {
		expect(() =>
			validateDocumentOperationBytes(operation, DOCUMENT_OPERATION_LIMITS[operation])
		).not.toThrow();
		expect(() =>
			validateDocumentOperationBytes(operation, DOCUMENT_OPERATION_LIMITS[operation] + 1n)
		).toThrow();
	}
});

it('fits 16M control characters, maximum R and 3 MiB of inline media together', () => {
	const inlineBytes = 64 * 1024;
	const inline = 'data:image/png;base64,' + btoa('a'.repeat(inlineBytes));
	const portable = Object.fromEntries(
		Object.entries(resources).map(([id, resource], index) => [
			id,
			{ ...resource, data: index < 48 ? inline : 'helia-asset:' + 'a'.repeat(64) }
		])
	);
	const content = {
		resources: portable,
		x: '\0'.repeat(CONTENT_CHARACTER_LIMIT - 'resources'.length - 1)
	};
	expect(resourceListBytes(portable)).toBe(RESOURCE_LIST_BYTES);
	expect(() => validateGameReleaseContent(content)).not.toThrow();
	const bytes = jsonUtf8Bytes(content);
	expect(bytes).toBeGreaterThan(120706048n);
	for (const operation of ['commit', 'releaseCreate'] as const) {
		expect(() => validateDocumentOperationBytes(operation, bytes)).not.toThrow();
	}
}, 30000);

it('fits the maximum node count with control strings and positive or negative maximum numbers', () => {
	const value = [
		'\0'.repeat(CONTENT_CHARACTER_LIMIT),
		...Array.from({ length: CONTENT_NODE_LIMIT - 2 }, (_, index) =>
			index % 2 ? -Number.MAX_VALUE : Number.MAX_VALUE
		)
	];
	expect(() => validateGameReleaseContent(value)).not.toThrow();
	const bytes = jsonUtf8Bytes(value);
	expect(bytes).toBeGreaterThan(
		6n * BigInt(CONTENT_CHARACTER_LIMIT) + 8n * BigInt(CONTENT_NODE_LIMIT) + 65536n
	);
	expect(bytes).toBeLessThanOrEqual(DOCUMENT_OPERATION_LIMITS.commit - RESOURCE_LIST_BYTES);
});

it('checks actual JSON bytes at 20 MiB, including control escapes', () => {
	const value = { text: '\0'.repeat(1024) };
	value.text += 'x'.repeat(Number(SAVE_REQUEST_BYTES - jsonUtf8Bytes(value)));
	expect(() => checkSaveRequestSize(value)).not.toThrow();
	value.text += 'x';
	expect(() => checkSaveRequestSize(value)).toThrow('저장할 내용이 너무 커요');
});

it('uses identical R boundaries for host commit, draft baseline and release creation', async () => {
	const store = openStorage(':memory:');
	try {
		const repo = createGameRepository(async (request) => store.request(request));
		const game = await repo.createGame();
		const updated = { ...game, resources };
		const write = (version: number) => ({
			kind: 'commit',
			gameId: game.id,
			version,
			records: [storedRecord('games', updated)],
			deleteSessions: []
		});
		const saved = store.request(parseRequest(write(0)));
		const draft = createEditorDraft(game);
		draft.baseContent.resources = resources;
		draft.documents.assets = '{unfinished';
		validateEditorDraftBudget(draft);
		const drafts = editorDraftStorage(store.connection);
		drafts.write(game.id, draft, 0);
		expect(drafts.read(game.id).version).toBe(1);
		const released = store.request({
			kind: 'versioning',
			gameId: game.id,
			action: 'release',
			contentVersion: '1.0.0'
		});
		expect(released.releaseResult?.kind).toBe('released');
		if (released.releaseResult?.kind === 'released') {
			const releaseId = released.releaseResult.state.currentRelease!.id;
			const frozen = store.request({
				kind: 'versioning',
				gameId: game.id,
				action: 'getRelease',
				releaseId
			});
			expect(() => parseGameRelease(frozen.release)).not.toThrow();
		}
		resources[last].name += 'x';
		try {
			expect(() => store.request(write(saved.version))).toThrow('리소스 목록이 너무 커요');
			const previous = store.request({ kind: 'read', gameId: game.id });
			expect(previous.version).toBe(saved.version);
			expect(
				resourceListBytes((previous.records[0].value as { resources: GameResources }).resources)
			).toBe(RESOURCE_LIST_BYTES);
			expect(() => drafts.write(game.id, draft, 1)).toThrow('리소스 목록이 너무 커요');
			expect(drafts.read(game.id).version).toBe(1);
			expect(readEditorDraft(JSON.stringify(draft), game.id).documents.assets).toBe('{unfinished');
			store.connection
				.prepare('UPDATE games SET value=? WHERE id=?')
				.run(JSON.stringify(updated), game.id);
			expect(() =>
				store.request({
					kind: 'versioning',
					gameId: game.id,
					action: 'release',
					contentVersion: '2.0.0'
				})
			).toThrow('리소스 목록이 너무 커요');
		} finally {
			resources[last].name = resources[last].name.slice(0, -1);
		}
	} finally {
		store.close();
	}
}, 60000);

it('bounds unfinished asset strings after JSON escaping and excludes both resource copies from 16M', async () => {
	const store = openStorage(':memory:');
	try {
		const game = await createGameRepository(async (request) => store.request(request)).createGame();
		const draft = createEditorDraft(game);
		draft.documents.assets = 'x'.repeat(Number(2n * RESOURCE_LIST_BYTES));
		expect(() => validateEditorDraftBudget(draft)).not.toThrow();
		draft.documents.assets += 'x';
		expect(() => validateEditorDraftBudget(draft)).toThrow('리소스 목록이 너무 커요');
		const length = Number(2n * RESOURCE_LIST_BYTES);
		draft.documents.assets = '\0'.repeat(Math.floor(length / 6)) + 'x'.repeat(length % 6);
		expect(() => validateEditorDraftBudget(draft)).not.toThrow();
		expect(jsonUtf8Bytes({ draft })).toBeLessThanOrEqual(DOCUMENT_OPERATION_LIMITS.draftSave);
		draft.documents.assets += 'x';
		expect(() => validateEditorDraftBudget(draft)).toThrow('리소스 목록이 너무 커요');
	} finally {
		store.close();
	}
}, 30000);
