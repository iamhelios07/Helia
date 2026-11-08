import { describe, expect, it } from 'vitest';

import { evaluateAction } from './engine.js';
import { CreatorRuntimeError, encodeInput, type ActionRequest } from './protocol.js';

const schema = {
	type: 'object',
	properties: { gold: { type: 'integer' } },
	required: ['gold'],
	additionalProperties: false
} as const;
const args = `{type:'object', properties:{price:{type:'integer'}}, required:['price'], additionalProperties:false}`;
const register = (body: string) =>
	`helia.defineAction({name:'buy', arguments:${args}, description:'아이템 구매', run({state,args}) { ${body} }});`;
function request(
	source = register('state.gold -= args.price; return state;'),
	language = 'javascript'
): ActionRequest {
	return {
		schema: { ...schema, required: ['gold'] },
		state: { gold: 100 },
		scripts: { main: { language, source } },
		action: { name: 'buy', args: { price: 20 } }
	};
}
describe('isolated creator Actions', () => {
	it('executes JavaScript and TypeScript against detached state and declared arguments', async () => {
		const input = request();
		expect(await evaluateAction(input)).toEqual({
			state: { gold: 80 },
			description: '아이템 구매'
		});
		expect(input.state).toEqual({ gold: 100 });
		expect(
			await evaluateAction(
				request(
					`type State = {gold:number};
			helia.defineAction({name:'buy', arguments:${args}, run({state,args}: {state:State; args:{price:number}}):State {state.gold-=args.price; return state;}});`,
					'typescript'
				)
			)
		).toEqual({ state: { gold: 80 } });
	});
});

describe('isolated creator Actions', () => {
	it.each([
		'fetch',
		'XMLHttpRequest',
		'WebSocket',
		'Worker',
		'importScripts',
		'postMessage',
		'document',
		'window',
		'localStorage',
		'indexedDB',
		'navigator',
		'process',
		'require',
		'Deno',
		'Bun',
		'__TAURI__',
		'__TAURI_INTERNALS__',
		'WebAssembly'
	])('does not expose %s, even through Function constructors', async (capability) => {
		const source = register(
			`if (Function('return typeof ${capability}')() !== 'undefined') throw Error('host exposed'); return state;`
		);
		expect((await evaluateAction(request(source))).state).toEqual({ gold: 100 });
	});
});

describe('isolated creator Actions', () => {
	it('disables imports and cannot obtain host globals through constructor escapes', async () => {
		await expect(
			evaluateAction(request(`import x from 'https://example.com/x.js';`))
		).rejects.toMatchObject({ code: 'script' });
		const source = register(
			`const root = ({}).constructor.constructor('return globalThis')(); if (root.process || root.fetch || root.__TAURI_INTERNALS__) throw Error('escape'); return state;`
		);
		expect((await evaluateAction(request(source))).state).toEqual({ gold: 100 });
	});
});

describe('isolated creator Actions', () => {
	it('rejects invalid arguments before invoking the action', async () => {
		const input = request(register('throw Error("must not execute");'));
		input.action.args.price = '20';
		await expect(evaluateAction(input)).rejects.toMatchObject({ code: 'arguments' });
	});
});

describe('isolated creator Actions', () => {
	it.each([
		'return {gold:"bad"};',
		'return {gold:80,extra:true};',
		'return {gold:NaN};',
		'return {gold:undefined};',
		'return Promise.resolve(state);',
		'return new Date();',
		`return Object.defineProperty({},'gold',{enumerable:true,get(){return 80;}});`,
		`return {gold:100, toJSON(){return {gold:80};}};`
	])('rejects invalid results without implicit serialization conversion: %s', async (body) => {
		await expect(evaluateAction(request(register(body)))).rejects.toBeInstanceOf(
			CreatorRuntimeError
		);
	});
});

describe('isolated creator Actions', () => {
	it('poisons invalid registration even if creator code catches the error', async () => {
		await expect(
			evaluateAction(
				request(`${register('return state;')} try { ${register('return state;')} } catch {}`)
			)
		).rejects.toMatchObject({ code: 'registration' });
		await expect(evaluateAction(request('', 'ruby'))).rejects.toThrow();
		await expect(
			evaluateAction({ ...request(), action: { name: 'unknown', args: {} } })
		).rejects.toMatchObject({ code: 'action-not-found' });
	});
});

describe('isolated creator Actions', () => {
	it('interrupts infinite loops and bounds memory and recursive execution', async () => {
		await expect(evaluateAction(request(register('while(true) {}')))).rejects.toMatchObject({
			code: 'timeout'
		});
		await expect(
			evaluateAction(request(register('new ArrayBuffer(32*1024*1024); return state;')))
		).rejects.toBeInstanceOf(CreatorRuntimeError);
		await expect(
			evaluateAction(request(register('function recurse(){return recurse();} return recurse();')))
		).rejects.toBeInstanceOf(CreatorRuntimeError);
	});
});

describe('isolated creator Actions', () => {
	it('does not leak script globals between invocations and never converts creator-thrown objects in the host', async () => {
		await evaluateAction(request(`globalThis.secret='private'; ${register('return state;')}`));
		expect(
			(
				await evaluateAction(
					request(register(`if ('secret' in globalThis) throw Error('leak'); return state;`))
				)
			).state
		).toEqual({ gold: 100 });
		await expect(
			evaluateAction(
				request(
					register(
						`throw {get name(){while(true){}}, get message(){while(true){}}, toString(){while(true){}}};`
					)
				)
			)
		).rejects.toMatchObject({ code: 'execution' });
	});
});

describe('isolated creator Actions', () => {
	it('bounds input size before sending code to a worker', () => {
		expect(() => encodeInput(request('x'.repeat(600 * 1024)))).toThrow(CreatorRuntimeError);
	});
});
