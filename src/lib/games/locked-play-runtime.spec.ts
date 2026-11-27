import { afterEach, expect, it, vi } from 'vitest';

import type { Game } from './model.js';

import playFixtures from '../storage/fixtures/edit-lock-play.json';
import * as codeProject from './code-project.js';
import { LockedPlayRuntimeCache } from './locked-play-runtime.js';
import { parseGame } from './model.js';

afterEach(() => vi.restoreAllMocks());

function game(): Game {
	const { install } = playFixtures[0];
	return parseGame({
		...install.release.content,
		schemaVersion: 2,
		id: install.gameId,
		activeSessionId: install.sessionId,
		createdAt: install.release.createdAt,
		updatedAt: install.release.createdAt,
		editLock: true
	});
}

it('shares pending compilation and returns detached runtime data', async () => {
	const input = game();
	const compile = vi.spyOn(codeProject, 'compileAuthoringGame').mockResolvedValue(input);
	const cache = new LockedPlayRuntimeCache();
	const [first, second] = await Promise.all([cache.prepare(input), cache.prepare(input)]);
	expect(compile).toHaveBeenCalledTimes(1);
	first.scripts.main.source = 'mutated';
	first.ui!.modules = {};
	expect(second.scripts).toEqual(input.scripts);
	expect((await cache.prepare(input)).ui).toEqual(input.ui);
	expect(compile).toHaveBeenCalledTimes(1);
});

const changes: { name: string; change: (input: Game) => void }[] = [
	{ name: 'script source', change: (input) => (input.scripts.main.source += '\n// changed') },
	{ name: 'script language', change: (input) => (input.scripts.main.language = 'javascript') },
	{ name: 'persisted script build', change: (input) => (input.scripts.main.compiled = 'changed') },
	{
		name: 'schema',
		change: (input) => (input.schema = { ...input.schema, title: 'Changed schema' })
	},
	{
		name: 'UI source',
		change: (input) => (input.ui!.modules['main.tsx'].source += '\n// changed')
	},
	{ name: 'UI presentation', change: (input) => (input.ui!.chatRatio = 0.4) },
	{ name: 'stylesheet', change: (input) => (input.ui!.styles = 'p { color: red; }') },
	{
		name: 'authoring project',
		change: (input) => (input.code = codeProject.createCodeProject(input))
	}
];

it.each(changes)('invalidates changed $name under the same game ID', async ({ change }) => {
	const input = game();
	const compile = vi
		.spyOn(codeProject, 'compileAuthoringGame')
		.mockImplementation(async (game) => game);
	const cache = new LockedPlayRuntimeCache();
	await cache.prepare(input);
	const changed = structuredClone(input);
	change(changed);
	await cache.prepare(changed);
	await cache.prepare(changed);
	expect(compile).toHaveBeenCalledTimes(2);
	expect(compile).toHaveBeenLastCalledWith(changed);
});

it('reuses runtime across session and metadata changes, but keeps games separate', async () => {
	const input = game();
	const compile = vi.spyOn(codeProject, 'compileAuthoringGame').mockResolvedValue(input);
	const cache = new LockedPlayRuntimeCache();
	await cache.prepare(input);
	await cache.prepare({ ...input, activeSessionId: 'another-session', title: 'Renamed' });
	expect(compile).toHaveBeenCalledTimes(1);
	await cache.prepare({ ...input, id: 'another-game' });
	expect(compile).toHaveBeenCalledTimes(2);
});

it('evicts the least recently used game after four entries', async () => {
	const input = game();
	const compile = vi.spyOn(codeProject, 'compileAuthoringGame').mockResolvedValue(input);
	const cache = new LockedPlayRuntimeCache();
	for (const id of ['a', 'b', 'c', 'd', 'a', 'e', 'a']) {
		await cache.prepare({ ...input, id });
	}
	expect(compile).toHaveBeenCalledTimes(5);
	await cache.prepare({ ...input, id: 'b' });
	expect(compile).toHaveBeenCalledTimes(6);
});

it('retries after compilation fails instead of retaining a rejected result', async () => {
	const input = game();
	const compile = vi
		.spyOn(codeProject, 'compileAuthoringGame')
		.mockRejectedValueOnce(Error('build failed'))
		.mockResolvedValue(input);
	const cache = new LockedPlayRuntimeCache();
	await expect(cache.prepare(input)).rejects.toThrow('build failed');
	expect(await cache.prepare(input)).toEqual({ scripts: input.scripts, ui: input.ui });
	expect(compile).toHaveBeenCalledTimes(2);
});

it('keeps concurrent fingerprints separate when the older build finishes last', async () => {
	const input = game();
	const changed = structuredClone(input);
	changed.scripts.main.source += '\n// replaced installation';
	const older = Promise.withResolvers<Game>();
	const newer = Promise.withResolvers<Game>();
	const compile = vi
		.spyOn(codeProject, 'compileAuthoringGame')
		.mockReturnValueOnce(older.promise)
		.mockReturnValueOnce(newer.promise);
	const cache = new LockedPlayRuntimeCache();
	const first = cache.prepare(input);
	const second = cache.prepare(changed);
	newer.resolve(changed);
	expect((await second).scripts).toEqual(changed.scripts);
	older.resolve(input);
	expect((await first).scripts).toEqual(input.scripts);
	expect((await cache.prepare(changed)).scripts).toEqual(changed.scripts);
	expect(compile).toHaveBeenCalledTimes(2);
});

it('does not remove the newer pending entry when an older fingerprint fails', async () => {
	const input = game();
	const changed = structuredClone(input);
	changed.scripts.main.source += '\n// replacement';
	const older = Promise.withResolvers<Game>();
	const newer = Promise.withResolvers<Game>();
	const compile = vi
		.spyOn(codeProject, 'compileAuthoringGame')
		.mockReturnValueOnce(older.promise)
		.mockReturnValueOnce(newer.promise);
	const cache = new LockedPlayRuntimeCache();
	const first = expect(cache.prepare(input)).rejects.toThrow('older failed');
	const second = cache.prepare(changed);
	older.reject(Error('older failed'));
	await first;
	const shared = cache.prepare(changed);
	newer.resolve(changed);
	expect(await shared).toEqual(await second);
	expect(compile).toHaveBeenCalledTimes(2);
});

it('lets an evicted pending build finish without replacing newer cached games', async () => {
	const input = game();
	const pending = Promise.withResolvers<Game>();
	const compile = vi
		.spyOn(codeProject, 'compileAuthoringGame')
		.mockReturnValueOnce(pending.promise)
		.mockResolvedValue(input);
	const cache = new LockedPlayRuntimeCache();
	const first = cache.prepare(input);
	for (const id of ['a', 'b', 'c', 'd']) {
		await cache.prepare({ ...input, id });
	}
	pending.resolve(input);
	expect((await first).scripts).toEqual(input.scripts);
	await cache.prepare({ ...input, id: 'd' });
	expect(compile).toHaveBeenCalledTimes(5);
	await cache.prepare(input);
	expect(compile).toHaveBeenCalledTimes(6);
});

it('extracts only runtime fields from the actual authoring compiler result', async () => {
	const input = game();
	input.code = codeProject.createCodeProject(input);
	const compile = vi.spyOn(codeProject, 'compileAuthoringGame');
	const cache = new LockedPlayRuntimeCache();
	const first = await cache.prepare(input);
	const compiled = await compile.mock.results[0].value;
	expect(Object.keys(compiled)).toContain('code');
	expect(Object.keys(compiled)).toContain('id');
	expect(first).toEqual({ scripts: compiled.scripts, ui: compiled.ui });
	expect(Object.keys(first).sort()).toEqual(['scripts', 'ui']);
	expect(first.scripts.project.language).toBe('javascript');
	expect(first.scripts.project.compiled).toBeTypeOf('string');
	expect(first.ui?.compiled).toBeDefined();
	expect(await cache.prepare(input)).toEqual(first);
	expect(compile).toHaveBeenCalledTimes(1);
});
