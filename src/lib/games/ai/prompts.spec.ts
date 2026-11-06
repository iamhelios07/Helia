import { describe, it, expect } from 'vitest';
import { assemblePrompt, importPromptPreset, parsePromptConfig } from './prompts.js';
import type { PromptContext } from './prompts.js';

const context: PromptContext = {
	settings: { description: 'World', firstMessage: 'Opening', authorNote: 'Note' },
	messages: [
		{
			schemaVersion: 1,
			id: 'one',
			gameId: 'game',
			sessionId: 'session',
			sequence: 1,
			role: 'user',
			content: 'Visit Castle',
			createdAt: '2026-11-06T00:00:00Z'
		},
		{
			schemaVersion: 1,
			id: 'two',
			gameId: 'game',
			sessionId: 'session',
			sequence: 2,
			role: 'assistant',
			content: 'Welcome',
			createdAt: '2026-11-06T00:00:01Z'
		}
	],
	transactions: [],
	memories: [
		{
			schemaVersion: 1,
			id: 'memory',
			gameId: 'game',
			sessionId: 'session',
			content: 'A promise',
			sourceTransactionIds: ['event'],
			createdAt: '2026-11-06T00:00:00Z'
		}
	],
	state: { gold: 2 }
};
describe('Risu-style prompt configuration', () => {
	it('assembles all prompt types in authored order, preserving roles and special types without evaluating CBS', () => {
		const ai = parsePromptConfig({
			version: 2,
			promptTemplate: [
				{ type: 'plain', type2: 'main', role: 'system', text: 'Main' },
				{ type: 'plain', type2: 'globalNote', role: 'user', text: 'Global' },
				{ type: 'plain', type2: 'normal', role: 'bot', text: '{{unknown}}' },
				{ type: 'jailbreak', text: 'Alternate', role: 'system' },
				{ type: 'cot', text: 'Reason', role: 'system' },
				{ type: 'description', role: 'user', innerFormat: 'World: {{slot}}' },
				{ type: 'persona', text: 'Player' },
				{ type: 'lorebook' },
				{ type: 'memory' },
				{ type: 'chat', rangeStart: -1, rangeEnd: 'end' },
				{ type: 'authornote', role: 'bot' },
				{ type: 'chatML', text: '<|im_start|>user\nChatML<|im_end|>' },
				{ type: 'postEverything', text: 'Last' },
				{ type: 'cache', role: 'all', depth: 2 }
			]
		});
		const messages = assemblePrompt(ai, {
			...context,
			lorebook: [
				{ keys: ['castle'], content: 'Castle lore' },
				{ keys: ['forest'], content: 'Forest lore' },
				{ keys: [], content: 'Always', always: true }
			]
		});
		expect(messages.slice(0, 6)).toEqual([
			{ role: 'system', content: 'Main' },
			{ role: 'user', content: 'Global' },
			{ role: 'assistant', content: '{{unknown}}' },
			{ role: 'system', content: 'Alternate' },
			{ role: 'system', content: 'Reason' },
			{ role: 'user', content: 'World: World' }
		]);
		expect(messages.map((m) => m.content)).toContain('Castle lore\n\nAlways');
		expect(messages.map((m) => m.content)).toContain('Player');
		expect(messages.map((m) => m.content)).toContain('Last');
		expect(messages.map((m) => m.content)).not.toContain('Forest lore');
		expect(messages.filter((m) => m.cache)).toHaveLength(2);
		expect(messages.at(-1)?.content).toContain('"gold":2');
		expect(messages.at(-1)?.cache).toBeUndefined();
	});
	it('supports author-note fallback, disabled blocks, prompt toggles and original chat roles', () => {
		const ai = parsePromptConfig({
			jailbreakEnabled: false,
			cotEnabled: false,
			promptSettings: { sendChatAsSystem: true, postEndInnerFormat: 'After' },
			promptTemplate: [
				{ type: 'jailbreak', text: 'Skip' },
				{ type: 'cot', text: 'Skip' },
				{ type: 'plain', text: 'Skip', enabled: false },
				{ type: 'chat', rangeStart: 0, rangeEnd: 1 },
				{ type: 'chat', rangeStart: 1, rangeEnd: 'end', chatAsOriginalOnSystem: true },
				{ type: 'authornote', defaultText: 'Fallback' },
				{ type: 'postEverything' }
			]
		});
		expect(
			assemblePrompt(ai, { ...context, settings: { ...context.settings, authorNote: '' } }).slice(
				0,
				-1
			)
		).toEqual([
			{ role: 'system', content: 'Visit Castle' },
			{ role: 'assistant', content: 'Welcome' },
			{ role: 'system', content: 'Fallback' },
			{ role: 'system', content: 'After' }
		]);
	});
	it('rebuilds a JSON preset without importing private or unrelated fields', () => {
		const ai = importPromptPreset({
			promptTemplate: [{ type: 'plain', type2: 'main', role: 'assistant', text: 'Hello' }],
			maxResponse: 200,
			jailbreakToggle: false,
			openAIKey: 'not-a-real-key'
		});
		expect(ai.maxTokens).toBe(200);
		expect(ai.jailbreakEnabled).toBe(false);
		expect(ai.promptTemplate[0].role).toBe('bot');
		expect(ai).not.toHaveProperty('openAIKey');
	});
	it.each([1, 2])(
		'normalizes legacy Helia version %s effective roles into one saved field',
		(version) => {
			const legacy = {
				version,
				promptTemplate: [
					{ type: 'plain', text: 'Instructions', role: 'system', role2: 'user' },
					{ type: 'description', role: 'user', role2: 'assistant' },
					{ type: 'authornote', role: 'user' },
					{ type: 'cache', role: 'all', role2: 'user', depth: 2 }
				]
			};
			const config = parsePromptConfig(legacy);
			expect(config.promptTemplate.map((block) => block.role)).toEqual([
				'user',
				'bot',
				'user',
				'all'
			]);
			expect(
				assemblePrompt(config, context)
					.slice(0, -1)
					.map((message) => message.role)
			).toEqual(['user', 'assistant', 'user']);
			expect(
				assemblePrompt(config, context)
					.slice(0, -1)
					.map((message) => !!message.cache)
			).toEqual([false, true, true]);
			for (const block of config.promptTemplate) expect(block).not.toHaveProperty('role2');
			expect(parsePromptConfig(JSON.parse(JSON.stringify(config)))).toEqual(config);
			expect(importPromptPreset(legacy)).toEqual(config);
		}
	);
	it('imports Risu roles by block kind, ignoring stale fields and normalizing assistant aliases', () => {
		const config = importPromptPreset({
			promptTemplate: [
				{ type: 'plain', text: 'Plain', role: 'user', role2: 'bot' },
				{ type: 'persona', text: 'Player', role: 'bot', role2: 'user' },
				{ type: 'description', role: 'user', role2: 'assistant' },
				{ type: 'authornote', role: 'bot' },
				{ type: 'chat', role: 'system', role2: 'bot' },
				{ type: 'cache', role: 'all', role2: 'user', depth: 1 }
			]
		});
		expect(config.promptTemplate.map((block) => block.role)).toEqual([
			'user',
			'user',
			'bot',
			undefined,
			undefined,
			'all'
		]);
		for (const block of config.promptTemplate) expect(block).not.toHaveProperty('role2');
		expect(
			assemblePrompt(config, context)
				.slice(0, -1)
				.map((message) => message.role)
		).toEqual(['user', 'user', 'assistant', 'system', 'user', 'assistant']);
	});
	it('migrates legacy shared bodies into every matching block while retaining order, formatting and enabled flags', () => {
		const ai = importPromptPreset({
			version: 1,
			mainPrompt: 'Legacy main',
			globalNote: 'Legacy global',
			persona: 'Legacy persona',
			postEverything: 'Legacy last',
			promptTemplate: [
				{ type: 'plain', type2: 'main', text: 'Unused fallback', role: 'user' },
				{ type: 'cot', type2: 'main', text: 'Other fallback', enabled: false },
				{ type: 'plain', type2: 'globalNote', text: 'Fallback', role: 'bot' },
				{ type: 'persona', innerFormat: 'Player: {{slot}}' },
				{ type: 'postEverything', innerFormat: 'Last: {{slot}}' }
			]
		});
		expect(ai.version).toBe(2);
		expect(ai.promptTemplate.map((block) => block.text)).toEqual([
			'Legacy main',
			'Legacy main',
			'Legacy global',
			'Legacy persona',
			'Legacy last'
		]);
		expect(ai.promptTemplate[1].enabled).toBe(false);
		expect(assemblePrompt(ai, context).slice(0, -1)).toEqual([
			{ role: 'user', content: 'Legacy main' },
			{ role: 'assistant', content: 'Legacy global' },
			{ role: 'system', content: 'Player: Legacy persona' },
			{ role: 'system', content: 'Last: Legacy last' }
		]);
		for (const key of ['mainPrompt', 'globalNote', 'persona', 'postEverything'])
			expect(ai).not.toHaveProperty(key);
		expect(parsePromptConfig(ai)).toEqual(ai);
	});
	it('preserves previously unreferenced legacy text in disabled blocks without injecting it into the request', () => {
		const ai = parsePromptConfig({
			version: 1,
			promptTemplate: [],
			mainPrompt: 'Unreferenced main',
			globalNote: 'Unreferenced global',
			persona: 'Unreferenced player',
			postEverything: 'Unreferenced last'
		});
		expect(ai.promptTemplate).toHaveLength(4);
		expect(ai.promptTemplate.every((block) => block.enabled === false)).toBe(true);
		expect(assemblePrompt(ai, context)).toHaveLength(1);
		expect(() =>
			parsePromptConfig({
				version: 1,
				promptTemplate: Array.from({ length: 128 }, () => ({ type: 'chat' })),
				mainPrompt: 'Keep this'
			})
		).toThrow('보존');
	});
	it('keeps per-block text independent and ignores removed shared fields in version 2', () => {
		const ai = parsePromptConfig({
			version: 2,
			mainPrompt: 'Ignored shared main',
			persona: 'Ignored shared persona',
			promptTemplate: [
				{ type: 'plain', type2: 'main', text: 'First main' },
				{ type: 'plain', type2: 'main', text: 'Second main' },
				{ type: 'persona', text: 'First player', innerFormat: '[{{slot}}]' },
				{ type: 'persona', text: 'Second player' },
				{ type: 'postEverything', text: 'Final instructions' }
			]
		});
		expect(
			assemblePrompt(ai, context)
				.slice(0, -1)
				.map((message) => message.content)
		).toEqual([
			'First main',
			'Second main',
			'[First player]',
			'Second player',
			'Final instructions'
		]);
		expect(ai).not.toHaveProperty('mainPrompt');
	});
	it('rejects malformed prompt types, roles and oversized context instead of silently coercing them', () => {
		expect(() => parsePromptConfig({ promptTemplate: [{ type: 'unsupported' }] })).toThrow();
		expect(() =>
			parsePromptConfig({ promptTemplate: [{ type: 'plain', role: 'developer' }] })
		).toThrow();
		expect(() =>
			parsePromptConfig({ version: 2, promptTemplate: [{ type: 'plain', role2: 'all' }] })
		).toThrow();
		expect(() =>
			importPromptPreset({ promptTemplate: [{ type: 'description', role2: 'developer' }] })
		).toThrow();
		expect(() => parsePromptConfig({ maxTokens: 'many' })).toThrow();
		expect(() =>
			assemblePrompt(
				parsePromptConfig({ maxContextChars: 1024, mainPrompt: 'x'.repeat(1025) }),
				context
			)
		).toThrow();
	});
});
