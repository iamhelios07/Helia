import { expect, it } from 'vitest';

import { invocation, migrationGame } from '../migration/test-fixtures.js';
import { evaluateAction } from './engine.js';
import { evaluateMigration } from './migration-engine.js';

function execute(body: string, prefix = '') {
	const game = migrationGame(body, prefix);
	return evaluateMigration([{ id: 'rules', source: game.scripts.rules.source }], invocation(game));
}
it('runs each input in a fresh context and keeps context deeply readonly', async () => {
	const body =
		'if(!Object.isFrozen(previous)||!Object.isFrozen(previousSchema.properties))throw Error(); return {coins:previous.gold + count++};';
	expect(await execute(body, 'let count=0;')).toEqual({ kind: 'state', value: { coins: 42 } });
	expect(await execute(body, 'let count=0;')).toEqual({ kind: 'state', value: { coins: 42 } });
});
it.each([
	'Math.random()',
	'Date.now()',
	'new Date()',
	'Date()',
	'Date.parse("2020")',
	'Date.UTC(2020)',
	'new WeakRef({})',
	'new FinalizationRegistry(()=>{})'
])('blocks nondeterminism before script evaluation: %s', async (code) => {
	await expect(execute('return {coins:0};', `const cached=${code};`)).rejects.toMatchObject({
		kind: 'exception'
	});
});
it.each([
	'Promise.resolve({coins:1})',
	'NaN',
	'undefined',
	'{get coins(){throw Error("secret");}}',
	'({coins:1,toJSON(){return {coins:2}}})'
])('classifies non JSON values without evaluating getters: %s', async (value) => {
	await expect(execute(`return ${value};`)).rejects.toMatchObject({ kind: 'nonJson' });
});
it.each([
	'helia.fetch("https://example.com")',
	'helia.secrets.has("key")',
	'helia.emit("x")',
	'helia.appendMessage({role:"assistant",content:"x"})',
	'helia.queueTurn("x")'
])('poisons forbidden capability attempts even when caught: %s', async (code) => {
	await expect(execute(`try{${code}}catch{};return {coins:1};`)).rejects.toMatchObject({
		kind: 'exception'
	});
});
it('stays deterministic when creator code catches forbidden nondeterminism', async () => {
	const body =
		'let seen=-1;try{Date.now()}catch{seen=1}try{Math.random()}catch{seen=seen+1}return {coins:seen};';
	expect(await execute(body)).toEqual({ kind: 'state', value: { coins: 2 } });
	expect(await execute(body)).toEqual({ kind: 'state', value: { coins: 2 } });
});
it('classifies depth-limit results as non-JSON rather than host exceptions', async () => {
	for (const depth of [255, 256]) {
		await expect(
			execute(`let v={coins:1};for(let i=0;i<${depth};i++)v={x:v};return v;`)
		).rejects.toMatchObject({ kind: 'nonJson' });
	}
});
it('keeps globals and host IO out of indirect eval and Function', async () => {
	expect(
		await execute(
			`const g=Function('return globalThis')(); if('fetch' in g || 'postMessage' in g || 'process' in g)throw Error();return {coins:1};`
		)
	).toMatchObject({ value: { coins: 1 } });
});
it('does not permit registration during migration', async () => {
	await expect(
		execute(`try{helia.defineMigration({name:'later',run(){return {}}});}catch{};return {coins:1};`)
	).rejects.toMatchObject({ kind: 'exception' });
});
it('retains exception and CPU timeout categories without creator error text', async () => {
	await expect(execute('throw Error("secret-state");')).rejects.toMatchObject({
		kind: 'exception',
		message: 'migration: exception'
	});
	await expect(execute('while(true){}')).rejects.toMatchObject({ kind: 'timeout' });
});
it('validates registration and from grammar even during an ordinary Action catalog', async () => {
	const game = migrationGame();
	const request = {
		scripts: game.scripts,
		schema: game.schema,
		state: game.initialState,
		action: { name: 'unused', args: {} },
		operation: { kind: 'catalog' as const }
	};
	expect(await evaluateAction(request)).toEqual({ state: { coins: 0 }, tools: [] });
	const source = game.scripts.rules.source.replace('<2.0.0', '^2.0.0');
	await expect(
		evaluateAction({
			...request,
			scripts: { rules: { language: 'typescript', source, compiled: source } }
		})
	).rejects.toMatchObject({ code: 'registration' });
});

it.each([
	'helia.defineMigration({name:"bad",run:1});',
	'helia.defineMigration({name:"",run(){return {}}});',
	'helia.defineMigration({name:"bad",from:1,run(){return {}}});',
	'helia.defineMigration({name:"bad",run(){return {}}});helia.defineMigration({name:"bad",run(){return {}}});'
])('classifies invalid migration registration in ordinary play: %s', async (source) => {
	const game = migrationGame();
	await expect(
		evaluateAction({
			schema: game.schema,
			state: game.initialState,
			scripts: { rules: { language: 'typescript', source, compiled: source } },
			action: { name: 'unused', args: {} },
			operation: { kind: 'catalog' }
		})
	).rejects.toMatchObject({ code: 'registration' });
});
it('cannot replace result validation through mutable JSON and prototype methods', async () => {
	await expect(
		execute(
			`JSON.stringify=()=>'{"ok":true,"value":{"coins":2}}';Object.prototype.toJSON=()=>({coins:2});Array.prototype.includes=()=>false;return {get coins(){return 2}};`
		)
	).rejects.toMatchObject({ kind: 'nonJson' });
	expect(await execute('return {coins:1};')).toMatchObject({ value: { coins: 1 } });
});

it('does not accept accessor descriptors with an inherited value property', async () => {
	await expect(
		execute(`Object.prototype.value=100;return {get coins(){throw Error();}};`)
	).rejects.toMatchObject({ kind: 'nonJson' });
});
