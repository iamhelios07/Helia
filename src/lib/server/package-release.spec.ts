import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { parseInstalledFrom } from '#lib/games/installed-from.js';
import minimal from '#lib/games/package/fixtures/minimal-release.json';
import { GamePackageError } from '#lib/games/package/limits.js';
import { verifyReleaseContent } from '#lib/games/package/verify.js';
import {
	parseConflictAcknowledgement,
	effectiveContentVersion,
	packageInstalledFrom,
	parseExistingHashes,
	type ConflictAcknowledgement,
	type InstallRequest
} from '#lib/storage/install.js';

import {
	packageConflictDecision,
	packageConflictHashes,
	packageReleaseTimestamp,
	selectPackageRelease,
	storePackageRelease
} from './package-release.js';
import { openStorage } from './sqlite.js';

const now = '2026-11-24T00:00:00.000Z';
const actual: ConflictAcknowledgement = {
	originalGameId: minimal.originalGameId,
	contentVersion: '2.0.0',
	incomingHash: minimal.contentHash,
	existingHashes: ['b'.repeat(64), 'c'.repeat(64)]
};
let store: ReturnType<typeof openStorage>;
beforeEach(() => {
	store = openStorage(':memory:');
});
afterEach(() => store.close());

it('binds the acknowledgement to origin, effective version, computed incoming hash and current K', () => {
	expect(packageConflictDecision(actual)).toEqual({ kind: 'conflict', ...actual });
	expect(packageConflictDecision(actual, actual)).toBeNull();
	for (const change of [
		{ originalGameId: randomUUID() },
		{ contentVersion: '3.0.0' },
		{ incomingHash: 'd'.repeat(64) },
		{ existingHashes: ['e'.repeat(64)] }
	]) {
		expect(packageConflictDecision(actual, { ...actual, ...change })).toEqual({
			kind: 'conflict',
			...actual
		});
	}
});
it('checks binding before empty K, and accepts a bound acknowledgement after conflicts disappear', () => {
	const empty = { ...actual, existingHashes: [] };
	expect(packageConflictDecision(empty)).toBeNull();
	expect(packageConflictDecision(empty, actual)).toBeNull();
	for (const change of [
		{ originalGameId: randomUUID() },
		{ contentVersion: '3.0.0' },
		{ incomingHash: 'd'.repeat(64) }
	]) {
		expect(() => packageConflictDecision(empty, { ...actual, ...change })).toThrow(
			new GamePackageError('staleAcknowledgement')
		);
	}
});

it.each([
	{ existingHashes: ['c'.repeat(64), 'b'.repeat(64)] },
	{ existingHashes: ['b'.repeat(64), 'b'.repeat(64)] },
	{ existingHashes: [minimal.contentHash] },
	{ existingHashes: Array(10001).fill('b'.repeat(64)) },
	{ existingHashes: ['bad'] },
	{ incomingHash: 'bad' },
	{ originalGameId: minimal.originalGameId.toUpperCase() },
	{ contentVersion: '01.0.0' }
])('rejects malformed acknowledgements %j', (change) => {
	expect(() => parseConflictAcknowledgement({ ...actual, ...change })).toThrow();
});
it('accepts exactly ten thousand sorted distinct conflict hashes', () => {
	const hashes = Array.from({ length: 10000 }, (_, i) => i.toString(16).padStart(64, '0'));
	expect(parseExistingHashes(hashes)).toEqual(hashes);
	expect(() => parseExistingHashes([...hashes, 'f'.repeat(64)])).toThrow();
});

it('bounds the active conflict query and rejects an installation without writing at K + 1', async () => {
	const input: InstallRequest = {
		kind: 'install',
		gameId: randomUUID(),
		sessionId: randomUUID(),
		release: minimal,
		packageFormatVersion: 1
	};
	await store.requestAsync(input);
	store.connection
		.prepare(
			`WITH RECURSIVE hashes(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM hashes WHERE n<10000)
		INSERT INTO game_releases(id,game_id,original_game_id,content_version,content_hash,created_at,content)
		SELECT 'fixture-'||n, ?, ?, '2.0.0', printf('%064x',n), ?, ? FROM hashes`
		)
		.run(input.gameId, minimal.originalGameId, now, JSON.stringify(minimal.content));
	expect(() =>
		packageConflictHashes(
			store.connection,
			{ ...minimal, contentVersion: '2.0.0' },
			minimal.contentHash
		)
	).toThrow();
	await expect(
		store.requestAsync({
			...input,
			gameId: randomUUID(),
			sessionId: randomUUID(),
			installContentVersion: '2.0.0'
		})
	).rejects.toMatchObject({ code: 'limit' });
	expect(store.connection.prepare('SELECT count(*) FROM games').pluck().get()).toBe(1);
});
it('calculates version, timestamp and provenance using the original package, including lower final versions', () => {
	const source = { release: minimal, packageFormatVersion: 1 };
	expect(effectiveContentVersion(source)).toBe('1.0.0');
	expect(packageReleaseTimestamp(source, now)).toBe(minimal.createdAt);
	for (const installContentVersion of ['0.5.0', '2.0.0', '2.0.0-beta.1+build.9']) {
		const changed = { ...source, installContentVersion };
		expect(effectiveContentVersion(changed)).toBe(installContentVersion);
		expect(packageReleaseTimestamp(changed, now)).toBe(now);
		const provenance = packageInstalledFrom(changed, now);
		expect(provenance.versionChanged).toBe(true);
		expect(provenance.packageRelease).toEqual({
			contentVersion: minimal.contentVersion,
			contentHash: minimal.contentHash,
			createdAt: minimal.createdAt
		});
		expect(parseInstalledFrom(provenance)).toEqual(provenance);
	}
	expect(() => effectiveContentVersion({ ...source, installContentVersion: '1.0.0' })).toThrow();
});
it('reuses an existing release without changing its identity or timestamp and selects it', async () => {
	const request: InstallRequest = {
		kind: 'install',
		gameId: randomUUID(),
		sessionId: randomUUID(),
		release: minimal,
		packageFormatVersion: 1
	};
	await store.requestAsync(request);
	const { content } = await verifyReleaseContent(minimal, {
		gameId: request.gameId,
		sessionId: request.sessionId,
		now
	});
	const first = storePackageRelease(store.connection, request, content, now);
	const second = storePackageRelease(
		store.connection,
		request,
		content,
		'2027-01-01T00:00:00.000Z'
	);
	expect(first).toEqual(second);
	expect(first.createdAt).toBe(minimal.createdAt);
	selectPackageRelease(store.connection, request.gameId, first.id);
	expect(store.connection.prepare('SELECT count(*) FROM game_releases').pluck().get()).toBe(1);
	expect(packageConflictHashes(store.connection, minimal, minimal.contentHash)).toEqual([]);
	expect(packageConflictHashes(store.connection, minimal)).toEqual([minimal.contentHash]);
	store.request({ kind: 'trash', gameId: request.gameId });
	expect(packageConflictHashes(store.connection, minimal)).toEqual([]);
});

it.each([
	{ kind: 'other' },
	{ packageFormatVersion: 0 },
	{ packageFormatVersion: 1.5 },
	{ versionChanged: 'yes' },
	{ installedAt: '2026-02-30T00:00:00.000Z' },
	{ installedAt: '2026-11-24T00:00:00Z' },
	{ unknown: true },
	{
		packageRelease: {
			contentVersion: '01.0.0',
			contentHash: minimal.contentHash,
			createdAt: minimal.createdAt
		}
	},
	{ packageRelease: { contentVersion: '1.0.0', contentHash: 'bad', createdAt: minimal.createdAt } },
	{
		packageRelease: {
			contentVersion: '1.0.0',
			contentHash: minimal.contentHash,
			createdAt: minimal.createdAt,
			extra: true
		}
	}
])('strict provenance validation %j', (change) => {
	const valid = packageInstalledFrom({ release: minimal, packageFormatVersion: 1 }, now);
	expect(() => parseInstalledFrom({ ...valid, ...change })).toThrow();
});
