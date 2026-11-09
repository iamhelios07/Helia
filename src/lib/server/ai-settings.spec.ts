import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { emptyAISettings, type AISettings } from '#lib/app/settings/model.js';

import { AI_SETTINGS_CONFLICT, aiSettingsStorage } from './ai-settings.js';

let directory: string;
let filename: string;
const connections: Database.Database[] = [];
const configured: AISettings = {
	version: 1,
	providers: [
		{
			id: 'connection',
			name: '내 연결',
			kind: 'openai-compatible',
			baseUrl: 'https://example.com/v1'
		}
	],
	models: [{ id: 'model', name: '내 모델', providerId: 'connection', modelId: 'org/model' }],
	defaultModelId: 'model'
};
function open() {
	const connection = new Database(filename);
	connection.pragma('busy_timeout = 5000');
	connections.push(connection);
	return connection;
}
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'helia-ai-settings-'));
	filename = join(directory, 'settings.sqlite');
});
afterEach(() => {
	for (const connection of connections.splice(0)) {
		if (connection.open) {
			connection.close();
		}
	}
	if (!resolve(directory).startsWith(resolve(tmpdir()) + sep + 'helia-ai-settings-')) {
		throw new Error('Unexpected test cleanup path');
	}
	rmSync(directory, { recursive: true, force: true });
});

it('persists the single settings snapshot across connections and reopening', () => {
	const first = open();
	const storage = aiSettingsStorage(first);
	expect(storage.read()).toEqual({ settings: null, revision: 0 });
	expect(storage.initialize(configured)).toEqual({ settings: configured, revision: 1 });
	first.close();
	expect(aiSettingsStorage(open()).read()).toEqual({ settings: configured, revision: 1 });
});

it('allows only the first independent initializer to write, even after both read absent', () => {
	const first = aiSettingsStorage(open());
	const second = aiSettingsStorage(open());
	expect(first.read().settings).toBeNull();
	expect(second.read().settings).toBeNull();
	const winner = first.initialize(configured);
	expect(second.initialize(emptyAISettings())).toEqual(winner);
	expect(first.read()).toEqual(winner);
});

it('retains empty settings as an initialized document and never reimports stale settings', () => {
	const storage = aiSettingsStorage(open());
	expect(storage.initialize(emptyAISettings())).toEqual({
		settings: emptyAISettings(),
		revision: 1
	});
	expect(storage.initialize(configured)).toEqual({ settings: emptyAISettings(), revision: 1 });
	expect(storage.write(configured, 1)).toEqual({ settings: configured, revision: 2 });
	expect(storage.write(emptyAISettings(), 2)).toEqual({ settings: emptyAISettings(), revision: 3 });
	expect(storage.initialize(configured)).toEqual({ settings: emptyAISettings(), revision: 3 });
});

it('rejects stale writes from independent clients without losing the winning update', () => {
	const first = aiSettingsStorage(open());
	const second = aiSettingsStorage(open());
	first.initialize(configured);
	const stale = second.read();
	const winner = first.write(emptyAISettings(), 1);
	expect(() => second.write(configured, stale.revision)).toThrow(AI_SETTINGS_CONFLICT);
	expect(second.read()).toEqual(winner);
	expect(second.write(configured, winner.revision)).toEqual({ settings: configured, revision: 3 });
});

it.each([-1, 0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])(
	'rejects unusable revision %s without replacing settings',
	(revision) => {
		const storage = aiSettingsStorage(open());
		storage.initialize(configured);
		expect(() => storage.write(emptyAISettings(), revision)).toThrow(AI_SETTINGS_CONFLICT);
		expect(storage.read()).toEqual({ settings: configured, revision: 1 });
	}
);

it('requires initialization and prevents revision overflow', () => {
	const connection = open();
	const storage = aiSettingsStorage(connection);
	expect(() => storage.write(configured, 1)).toThrow(AI_SETTINGS_CONFLICT);
	storage.initialize(configured);
	connection.prepare('UPDATE ai_settings SET revision=?').run(Number.MAX_SAFE_INTEGER);
	expect(() => storage.write(emptyAISettings(), Number.MAX_SAFE_INTEGER)).toThrow(
		AI_SETTINGS_CONFLICT
	);
	expect(storage.read()).toEqual({ settings: configured, revision: Number.MAX_SAFE_INTEGER });
});

it.each([null, {}, { ...configured, version: 2 }, { ...configured, providers: [] }])(
	'rejects invalid settings without changing the saved document',
	(invalid) => {
		const storage = aiSettingsStorage(open());
		expect(() => storage.initialize(invalid)).toThrow();
		expect(storage.read()).toEqual({ settings: null, revision: 0 });
		storage.initialize(configured);
		expect(() => storage.write(invalid, 1)).toThrow();
		expect(storage.read()).toEqual({ settings: configured, revision: 1 });
	}
);

it('strips undeclared credentials before storage and on every read', () => {
	const connection = open();
	const storage = aiSettingsStorage(connection);
	const unsafe = {
		...configured,
		apiKey: 'top-secret',
		providers: [
			{ ...configured.providers[0], apiKey: 'provider-secret', serviceAccount: 'private-key' }
		],
		models: [{ ...configured.models[0], secret: 'model-secret' }]
	};
	expect(storage.initialize(unsafe)).toEqual({ settings: configured, revision: 1 });
	const row = connection.prepare('SELECT value FROM ai_settings').get() as { value: string };
	expect(JSON.parse(row.value)).toEqual(configured);
	expect(storage.write(unsafe, 1)).toEqual({ settings: configured, revision: 2 });
	connection.prepare('UPDATE ai_settings SET value=?').run(JSON.stringify(unsafe));
	expect(storage.read()).toEqual({ settings: configured, revision: 2 });
	connection.prepare('UPDATE ai_settings SET value=?').run('{invalid');
	expect(() => storage.read()).toThrow();
});
