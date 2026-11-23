import { describe, expect, it } from 'vitest';

import { parseReply } from '#lib/storage/protocol.js';
import fixtures from '#lib/testing/fixtures/game-releases.json';

import type { Game } from './model.js';
import type { GameRelease, GameVersioning } from './versioning.js';

import { parseGame } from './model.js';
import { gameReleaseContent, hashGameReleaseContent } from './release-content.js';
import { compareSemVer, parseSemVer } from './versioning.js';

const origin = '12345678-1234-4234-8234-123456789abc';
const releaseId = '12345678-1234-4234-8234-123456789abd';
const timestamp = '2026-11-23T00:00:00.000Z';

function game(): Game {
	return parseGame({
		schemaVersion: 2,
		id: 'installation',
		originalGameId: origin,
		activeSessionId: 'session',
		createdAt: timestamp,
		updatedAt: timestamp,
		title: 'Adventure',
		genre: 'Fantasy',
		description: 'Library introduction',
		settings: {
			description: 'Game instructions',
			firstMessage: 'Welcome',
			authorNote: 'Stay in character'
		},
		schema: {
			type: 'object',
			properties: {
				hp: { type: 'number' },
				inventory: {
					type: 'object',
					properties: { potions: { type: 'integer' }, keys: { type: 'integer' } },
					additionalProperties: false
				}
			},
			additionalProperties: false
		},
		initialState: { hp: 10, inventory: { potions: 1, keys: 2 } },
		scripts: { main: { language: 'typescript', source: 'export const turn = 1;' } },
		ui: {
			version: 1,
			entry: 'main',
			modules: { main: { language: 'tsx', source: 'export default () => null;' } },
			styles: 'body { color: red; }',
			chatDock: 'left',
			chatRatio: 0.4
		},
		regex: [
			{
				id: 'rule',
				name: 'Display',
				enabled: true,
				stage: 'display',
				roles: ['assistant'],
				pattern: 'hello',
				replacement: 'welcome',
				flags: 'g'
			}
		],
		ai: { version: 1, lorebook: [{ keys: ['town'], content: 'The town is quiet.' }] },
		resources: {
			portrait: { name: 'portrait.png', mime: 'image/png', data: 'data:image/png;base64,AA==' }
		}
	});
}
function sourceGame(): Game {
	return {
		...game(),
		code: {
			version: 1,
			entry: 'main.ts',
			files: {
				'main.ts': { language: 'typescript', source: 'export {};' },
				'style.css': { language: 'css', source: 'body { color: red; }' }
			},
			presentation: { chatDock: 'right', chatRatio: 0.4, chatStyle: { background: '#000' } }
		}
	};
}
const digest = (value: Game) => hashGameReleaseContent(gameReleaseContent(value));
async function release(): Promise<GameRelease> {
	const content = gameReleaseContent(sourceGame());
	return {
		id: releaseId,
		originalGameId: origin,
		contentVersion: '1.0.0',
		contentHash: await hashGameReleaseContent(content),
		createdAt: timestamp,
		content
	};
}
function state(saved: GameRelease): GameVersioning {
	const { id, originalGameId, contentVersion, contentHash, createdAt } = saved;
	const summary = { id, originalGameId, contentVersion, contentHash, createdAt };
	return {
		originalGameId: origin,
		contentHash: saved.contentHash,
		currentRelease: summary,
		releases: [summary],
		modified: false
	};
}

describe('SemVer contract', () => {
	it.each(['0.0.0', '1.2.3', '1.1.0-beta.1', '1.0.0-0.3.7+build.001', '999999999999999999999.0.0'])(
		'accepts %s without losing numeric precision',
		(version) => {
			expect(parseSemVer(version).major).toBe(version.split('.')[0]);
		}
	);
	it.each([
		'1',
		'1.0',
		'v1.0.0',
		'01.0.0',
		'1.01.0',
		'1.0.01',
		'-1.0.0',
		'1.0.0-01',
		'1.0.0-alpha.01',
		'1.0.0-',
		'1.0.0+',
		'1.0.0-alpha..1',
		'1.0.0+build..1',
		'1.0.0\n',
		' 1.0.0',
		'1.0.0-한글'
	])('rejects invalid syntax %j', (version) => {
		expect(() => parseSemVer(version)).toThrow();
	});
	it('orders prereleases by SemVer precedence and ignores build metadata', () => {
		const ordered = [
			'1.0.0-alpha',
			'1.0.0-alpha.1',
			'1.0.0-alpha.beta',
			'1.0.0-beta',
			'1.0.0-beta.2',
			'1.0.0-beta.11',
			'1.0.0-rc.1',
			'1.0.0',
			'1.0.1',
			'1.1.0',
			'2.0.0'
		];
		for (let index = 1; index < ordered.length; index++) {
			expect(compareSemVer(ordered[index - 1], ordered[index])).toBeLessThan(0);
			expect(compareSemVer(ordered[index], ordered[index - 1])).toBeGreaterThan(0);
		}
		expect(compareSemVer('1.0.0+one', '1.0.0+two.001')).toBe(0);
		expect(compareSemVer('1.0.0-beta.2+one', '1.0.0-beta.2+two')).toBe(0);
		expect(compareSemVer('1.0.0-9', '1.0.0-alpha')).toBeLessThan(0);
	});
	it.each([
		['9007199254740992.0.0', '9007199254740993.0.0'],
		['1.9007199254740992.0', '1.9007199254740993.0'],
		['1.0.9007199254740992', '1.0.9007199254740993'],
		['1.0.0-9007199254740992', '1.0.0-9007199254740993'],
		['1.0.0-99', '1.0.0-100']
	])('orders large numeric components: %s < %s', (left, right) => {
		expect(compareSemVer(left, right)).toBeLessThan(0);
		expect(compareSemVer(right, left)).toBeGreaterThan(0);
	});
});

it.each(fixtures)('matches the shared native fixture: $name', async (fixture) => {
	const content = gameReleaseContent(parseGame(fixture.game));
	expect(content).toEqual(fixture.content);
	expect(await hashGameReleaseContent(content)).toBe(fixture.hash);
});
it('does not change when nested object keys are reordered', async () => {
	const original = game();
	const reordered = {
		...original,
		settings: {
			authorNote: original.settings.authorNote,
			firstMessage: original.settings.firstMessage,
			description: original.settings.description
		},
		initialState: { inventory: { keys: 2, potions: 1 }, hp: 10 }
	};
	expect(await digest(reordered)).toBe(await digest(original));
});
it.each(['title', 'genre', 'description'] as const)(
	'includes public metadata %s',
	async (field) => {
		const original = game();
		expect(await digest({ ...original, [field]: 'Changed' })).not.toBe(await digest(original));
	}
);
it.each(['description', 'firstMessage', 'authorNote'] as const)(
	'includes authored instruction %s',
	async (field) => {
		const original = game();
		expect(
			await digest({ ...original, settings: { ...original.settings, [field]: 'Changed' } })
		).not.toBe(await digest(original));
	}
);
const changes: [string, (value: Game) => void][] = [
	[
		'schema',
		(value) => {
			value.schema.title = 'New state title';
		}
	],
	[
		'initial state',
		(value) => {
			value.initialState.hp = 20;
		}
	],
	[
		'regex',
		(value) => {
			value.regex![0].replacement = 'goodbye';
		}
	],
	[
		'lorebook',
		(value) => {
			value.ai!.lorebook[0].content = 'New lore';
		}
	],
	[
		'resource bytes',
		(value) => {
			value.resources!.portrait.data = 'data:image/png;base64,AQ==';
		}
	],
	[
		'resource name',
		(value) => {
			value.resources!.portrait.name = 'renamed.png';
		}
	],
	[
		'legacy script source',
		(value) => {
			value.scripts.main.source = 'export const turn = 2;';
		}
	],
	[
		'legacy UI stylesheet',
		(value) => {
			value.ui!.styles = 'body { color: blue; }';
		}
	],
	[
		'legacy UI presentation',
		(value) => {
			value.ui!.chatDock = 'right';
		}
	]
];
it.each(changes)('changes when %s changes', async (_name, change) => {
	const original = game();
	const changed = structuredClone(original);
	change(changed);
	expect(await digest(changed)).not.toBe(await digest(original));
});
it('excludes installation identity, sessions and timestamps', async () => {
	const original = game();
	const changed = {
		...original,
		id: 'another-installation',
		originalGameId: crypto.randomUUID(),
		activeSessionId: 'another-session',
		createdAt: '2020-01-01T00:00:00.000Z',
		updatedAt: '2030-01-01T00:00:00.000Z',
		trashedAt: timestamp
	};
	expect(await digest(changed)).toBe(await digest(original));
});
it('excludes compiled scripts, source fingerprints and generated UI artifacts', async () => {
	const original = game();
	const changed = structuredClone(original);
	Object.assign(changed.scripts.main, {
		compiled: 'generated code',
		compiledFor: 'a'.repeat(64),
		artifact: 'b'.repeat(64)
	});
	Object.assign(changed.ui!, {
		artifact: 'c'.repeat(64),
		compiled: {
			version: 1,
			sourceHash: 'd'.repeat(64),
			entry: 'main',
			factories: 'generated UI',
			dependencies: {}
		}
	});
	expect(await digest(changed)).toBe(await digest(original));
});
it('uses the source project in preference to legacy or derived scripts and UI', async () => {
	const original = sourceGame();
	const changed = structuredClone(original);
	changed.scripts.main.source = 'different legacy code';
	changed.ui!.modules.main.source = 'different legacy UI';
	changed.ui!.styles = 'body { color: blue; }';
	const content = gameReleaseContent(changed);
	expect(content).not.toHaveProperty('scripts');
	expect(content).not.toHaveProperty('ui');
	expect(await digest(changed)).toBe(await digest(original));
});
it.each(['source', 'stylesheet', 'presentation'] as const)(
	'includes authoritative project %s',
	async (field) => {
		const original = sourceGame();
		const changed = structuredClone(original);
		if (field === 'presentation') {
			changed.code!.presentation!.chatDock = 'bottom';
		} else {
			const path = field === 'source' ? 'main.ts' : 'style.css';
			changed.code!.files[path].source += '\n/* changed */';
		}
		expect(await digest(changed)).not.toBe(await digest(original));
	}
);

describe('versioning wire reply contract', () => {
	it('strips unknown fields and credentials from parsed frozen content', async () => {
		const saved = await release();
		const secret = 'private-api-key-must-not-survive';
		const content = {
			...saved.content,
			apiKey: secret,
			credentials: { token: secret },
			settings: { ...saved.content.settings, apiKey: secret },
			resources: { portrait: { ...saved.content.resources!.portrait, accessToken: secret } },
			ai: { ...saved.content.ai, mainPrompt: secret, apiKey: secret },
			code: { ...saved.content.code, apiKey: secret }
		};
		const parsed = parseReply({
			version: 0,
			records: [],
			apiKey: secret,
			release: { ...saved, apiKey: secret, content }
		});
		expect(JSON.stringify(parsed)).not.toContain(secret);
		expect(parsed.release?.content.title).toBe(saved.content.title);
		expect(parsed.release?.content.settings).toEqual(saved.content.settings);
		expect(parsed.release?.content.resources?.portrait.data).toBe('data:image/png;base64,AA==');
		expect(parsed.release?.content.code).toEqual(saved.content.code);
	});
	it('rejects malformed release shapes and authored content', async () => {
		const saved = await release();
		const malformed: unknown[] = [
			null,
			[],
			{ ...saved, contentVersion: '01.0.0' },
			{ ...saved, contentHash: 'not-a-digest' },
			{ ...saved, originalGameId: 'foreign' },
			{ ...saved, createdAt: 'yesterday' },
			{ ...saved, content: null },
			{ ...saved, content: { ...saved.content, initialState: { hp: 'invalid' } } }
		];
		for (const value of malformed) {
			expect(() => parseReply({ version: 0, records: [], release: value })).toThrow();
		}
	});
	it('rejects inconsistent ownership, selection and modified status', async () => {
		const saved = await release();
		const valid = state(saved);
		const malformed: unknown[] = [
			{ ...valid, releases: 'invalid' },
			{ ...valid, releases: [] },
			{ ...valid, releases: [valid.currentRelease, valid.currentRelease] },
			{ ...valid, originalGameId: crypto.randomUUID() },
			{ ...valid, modified: true }
		];
		for (const value of malformed) {
			expect(() => parseReply({ version: 0, records: [], versioning: value })).toThrow();
		}
		expect(parseReply({ version: 0, records: [], versioning: valid }).versioning).toEqual(valid);
	});
	it('rejects malformed conflict results', () => {
		const valid = {
			kind: 'conflict',
			contentVersion: '1.0.0',
			existingHashes: ['a'.repeat(64)],
			incomingHash: 'b'.repeat(64)
		};
		for (const change of [
			{ existingHashes: [] },
			{ incomingHash: 'a'.repeat(64) },
			{ existingHashes: ['a'.repeat(64), 'a'.repeat(64)] },
			{ kind: 'success' }
		]) {
			expect(() =>
				parseReply({ version: 0, records: [], releaseResult: { ...valid, ...change } })
			).toThrow();
		}
	});
});
