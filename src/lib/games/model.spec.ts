import { describe, expect, it } from 'vitest';
import {
	GAME_DESCRIPTION_MAX_LENGTH,
	GAME_GENRE_MAX_LENGTH,
	GAME_TITLE_MAX_LENGTH,
	parseGame,
	parseSession,
	parseMessage,
	validateMessageContent,
	validateGameMetadata,
	validateGameSettings
} from './model.js';

describe('chat serialization', () => {
	const message = {
		schemaVersion: 1,
		id: 'message-1',
		gameId: 'game-1',
		sessionId: 'session-1',
		sequence: 1,
		role: 'user',
		content: '  행동\n\n대사  ',
		createdAt: '2026-11-02T00:00:00.000Z'
	};
	it('preserves message whitespace through JSON serialization', () => {
		expect(parseMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
		expect(validateMessageContent(message.content)).toBe(message.content);
	});
	it.each([
		{ sequence: 0 },
		{ sequence: 1.5 },
		{ sequence: Number.MAX_SAFE_INTEGER + 1 },
		{ role: 'system' },
		{ content: ' \n' },
		{ content: null },
		{ sessionId: '' },
		{ createdAt: 'invalid' }
	])('rejects invalid stored messages: %j', (change) => {
		expect(() => parseMessage({ ...message, ...change })).toThrow();
	});
	it('accepts sessions while rejecting invalid message counters', () => {
		const session = {
			schemaVersion: 1,
			id: 'session-1',
			gameId: 'game-1',
			title: '세션',
			createdAt: message.createdAt,
			updatedAt: message.createdAt
		};
		expect(parseSession(session)).toEqual(session);
		for (const messageCount of [-1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
			expect(() => parseSession({ ...session, messageCount })).toThrow();
		}
	});
});

describe('game metadata validation', () => {
	it('keeps game rules through serialization and rejects unsupported formats', () => {
		const input = {
			schemaVersion: 2,
			id: 'game',
			activeSessionId: 'session',
			title: '게임',
			genre: '',
			description: '',
			createdAt: '2026-11-02T00:00:00.000Z',
			updatedAt: '2026-11-02T00:00:00.000Z',
			schema: {
				type: 'object',
				properties: { gold: { type: 'integer' } },
				additionalProperties: false
			},
			initialState: { gold: 100 },
			scripts: { buy: { language: 'javascript', source: 'buy();' } },
			settings: { description: '', firstMessage: '', authorNote: '' }
		};
		const game = parseGame(input);
		expect(game.initialState).toEqual({ gold: 100 });
		expect(game.scripts).toEqual(input.scripts);
		expect(() => parseGame({ ...input, schemaVersion: 1 })).toThrow();
		expect(game).not.toHaveProperty('definition');
		expect(parseGame(JSON.parse(JSON.stringify(game)))).toEqual(game);
		expect(() =>
			parseGame({
				...game,
				schema: {
					type: 'object',
					properties: { gold: { type: 'integer' } },
					additionalProperties: false
				},
				initialState: undefined
			})
		).toThrow();
		expect(() => parseGame({ ...game, scripts: { bad: { language: '', source: '' } } })).toThrow();
	});
	it('normalizes input without inventing optional game content', () => {
		expect(validateGameMetadata({ title: '  새 게임  ', genre: ' ', description: '\n' })).toEqual({
			title: '새 게임',
			genre: '',
			description: ''
		});
	});

	it.each([
		null,
		{},
		{ title: 1, genre: '', description: '' },
		{ title: ' \n ', genre: '', description: '' }
	])('rejects malformed or blank metadata: %j', (value) => {
		expect(() => validateGameMetadata(value)).toThrow();
	});

	it.each([
		{ title: 'a'.repeat(GAME_TITLE_MAX_LENGTH + 1), genre: '', description: '' },
		{ title: '게임', genre: 'a'.repeat(GAME_GENRE_MAX_LENGTH + 1), description: '' },
		{ title: '게임', genre: '', description: 'a'.repeat(GAME_DESCRIPTION_MAX_LENGTH + 1) }
	])('enforces metadata size limits: %j', (value) => {
		expect(() => validateGameMetadata(value)).toThrow();
	});

	it('rejects unsupported stored formats and invalid session references', () => {
		const game = {
			schemaVersion: 2,
			id: 'game-1',
			activeSessionId: 'session-1',
			title: '새 게임',
			genre: '',
			description: '',
			createdAt: '2026-11-02T00:00:00.000Z',
			updatedAt: '2026-11-02T00:00:00.000Z',
			schema: {
				type: 'object',
				properties: { gold: { type: 'integer' } },
				additionalProperties: false
			},
			initialState: {},
			scripts: {},
			settings: { description: '', firstMessage: '', authorNote: '' }
		};
		expect(parseGame(game)).toEqual({
			...game,
			schemaVersion: 2,
			schema: {
				type: 'object',
				properties: { gold: { type: 'integer' } },
				additionalProperties: false
			},
			initialState: {},
			scripts: {},
			settings: { description: '', firstMessage: '', authorNote: '' }
		});
		expect(() => parseGame({ ...game, schemaVersion: 3 })).toThrow();
		expect(() => parseGame({ ...game, activeSessionId: '' })).toThrow();
		expect(() => parseGame({ ...game, updatedAt: 'invalid' })).toThrow();
		expect(() => parseSession({ ...game, gameId: '', title: '새 세션' })).toThrow();
	});
});

describe('game authoring settings', () => {
	it('preserves authoring text and accepts prompts beyond metadata size limits', () => {
		const input = {
			title: '  게임 이름  ',
			description: '\n  <system_role>\n' + '긴 설정 '.repeat(3000) + '\n</system_role>\n',
			firstMessage: '\n*첫 장면*\n\n',
			authorNote: '  메모\n'
		};
		expect(validateGameSettings(input)).toEqual({ ...input, title: '게임 이름' });
	});

	it.each([
		null,
		{},
		{ title: '', description: '', firstMessage: '', authorNote: '' },
		{ title: ' ', description: '', firstMessage: '', authorNote: '' },
		{
			title: 'a'.repeat(GAME_TITLE_MAX_LENGTH + 1),
			description: '',
			firstMessage: '',
			authorNote: ''
		},
		{ title: '게임', description: 1, firstMessage: '', authorNote: '' },
		{ title: '게임', description: '', firstMessage: null, authorNote: '' },
		{ title: '게임', description: '', firstMessage: '', authorNote: [] }
	])('rejects invalid settings: %j', (value) => {
		expect(() => validateGameSettings(value)).toThrow();
	});
});
