import { expect, it } from 'vitest';
import { compileCodeProject, CodeProjectError, type CodeProject } from './code-project.js';
import { evaluateAction } from './scripting/engine.js';
import type { GameState } from './state/value.js';

const schema = {
	type: 'object' as const,
	properties: { gold: { type: 'number' as const } },
	required: ['gold'],
	additionalProperties: false as const
};
function project(source: string, types = ''): CodeProject {
	return {
		version: 1,
		entry: 'main.ts',
		files: {
			'main.ts': { language: 'typescript', source: "export {default as logic} from './logic';" },
			'logic.ts': { language: 'typescript', source },
			'types.ts': { language: 'typescript', source: types }
		}
	};
}
async function scripts(source: string, types?: string) {
	return (await compileCodeProject(project(source, types), schema)).scripts;
}
const action = (type: string, prefix = '') => `${prefix}
export default function register() {
 helia.defineAction<${type}>({name:'buy',ai:true,description:'Buy an item',run({state,args}) { state.gold -= args.price; return state; }});
}`;
const run = (compiled: Awaited<ReturnType<typeof scripts>>, args: GameState) =>
	evaluateAction({
		schema,
		state: { gold: 100 },
		scripts: compiled,
		action: { name: 'buy', args }
	});

it('generates schemas from imported interfaces, inheritance, aliases and JSDoc without executing sources', async () => {
	const source = action('BuyArgs', "import type {BuyArgs} from './types';");
	const types = `
interface Base {
 /** Amount to spend. */
 price: number;
}
type Choice = 'sword' | 'shield';
export interface BuyArgs extends Base {
 item: Choice;
 note?: string;
 options: { enabled: boolean; tags: readonly string[]; owner: string | null };
}`;
	const input = project(source, types);
	const compiled = await compileCodeProject(input, schema);
	expect(input.files['logic.ts'].source).toBe(source);
	expect(compiled.scripts.project.source).not.toContain('interface BuyArgs');
	const result = await evaluateAction({
		schema,
		state: { gold: 100 },
		scripts: compiled.scripts,
		action: { name: 'catalog', args: {} },
		operation: { kind: 'catalog' }
	});
	expect(result.tools?.[0].arguments).toEqual({
		type: 'object',
		additionalProperties: false,
		required: ['item', 'options', 'price'],
		properties: {
			price: { type: 'number', description: 'Amount to spend.' },
			item: { type: 'string', enum: ['sword', 'shield'] },
			note: { type: 'string' },
			options: {
				type: 'object',
				additionalProperties: false,
				required: ['enabled', 'tags', 'owner'],
				properties: {
					enabled: { type: 'boolean' },
					tags: { type: 'array', items: { type: 'string' } },
					owner: { type: ['string', 'null'] }
				}
			}
		}
	});
	const args = {
		price: 20,
		item: 'sword',
		options: { enabled: true, tags: ['rare'], owner: null }
	};
	expect((await run(compiled.scripts, args)).state).toEqual({ gold: 80 });
	for (const invalid of [
		{ ...args, price: '20' },
		{ ...args, extra: true },
		{ ...args, item: 'axe' },
		{ ...args, options: { ...args.options, tags: [2] } },
		{ price: 20 }
	])
		await expect(run(compiled.scripts, invalid)).rejects.toMatchObject({ code: 'arguments' });
});

it('resolves generic aliases, utility types, finite records and generated game state types', async () => {
	const compiled = await scripts(
		action(
			'BuyArgs',
			`
import type {GameState} from '@helia/state';
type Box<T> = { price: T; flags?: Record<'known' | 'rare', boolean> };
type BuyArgs = Pick<Box<GameState['gold']>, 'price' | 'flags'>;`
		)
	);
	expect((await run(compiled, { price: 12, flags: { known: true, rare: false } })).state).toEqual({
		gold: 88
	});
});

it('uses the bundled TypeScript standard library when resolving utility types', async () => {
	const compiled = await scripts(
		action('Parameters<typeof buy>[0]', 'declare function buy(args:{price:number}):void;')
	);
	expect((await run(compiled, { price: 6 })).state).toEqual({ gold: 94 });
});

it('supports generic queries, literal enums and nullable arrays without mutation', async () => {
	const compiled = await scripts(`
export default function register(){
 helia.defineQuery<{ values: Array<1 | 2> | null; flag?: false }>({name:'read',ai:true,run({args}){return args.values;}});
}`);
	const input = {
		schema,
		state: { gold: 100 },
		scripts: compiled,
		action: { name: 'read', args: {} }
	};
	const result = await evaluateAction({
		...input,
		operation: { kind: 'query', name: 'read', args: { values: [1, 2] } }
	});
	expect(result.value).toEqual([1, 2]);
	expect(result.state).toEqual({ gold: 100 });
	expect(result.events).toBeUndefined();
	await expect(
		evaluateAction({ ...input, operation: { kind: 'query', name: 'read', args: { values: [3] } } })
	).rejects.toMatchObject({ phase: 'arguments' });
});

it('also materializes types for an aliased registration function and definitions stored in variables', async () => {
	const compiled = await scripts(`
const registerAction = helia.defineAction;
export default function register(){
 const definition = {name:'buy',run({state,args}:ActionContext<{price:number}>){state.gold -= args.price;return state;}};
 registerAction<{price:number}>(definition);
}`);
	expect((await run(compiled, { price: 5 })).state).toEqual({ gold: 95 });
	await expect(run(compiled, { price: '5' })).rejects.toMatchObject({ code: 'arguments' });
});

it.each([
	['any', ''],
	['unknown', ''],
	['never', ''],
	['string', ''],
	['number[]', ''],
	['Missing', ''],
	['{price:undefined}', ''],
	['{price:()=>number}', ''],
	['{price:string|number}', ''],
	['{price:[number,string]}', ''],
	['Record<string,number>', ''],
	['Loop', 'interface Loop {price:number; next?:Loop}'],
	['{price:T}', ''],
	['{price:bigint}', ''],
	['{price:Date}', ''],
	['Args', 'interface Args extends Missing {price:number}'],
	['{price:number} | {other:string}', '']
])('rejects types that cannot be faithfully represented (%s)', async (type, prefix) => {
	await expect(scripts(action(type, prefix))).rejects.toMatchObject({
		file: 'logic.ts',
		line: expect.any(Number),
		column: expect.any(Number)
	});
});

it('locates errors at the generic type and rejects conflicting explicit schemas', async () => {
	try {
		await scripts(action('unknown'));
		throw Error('Expected compile failure');
	} catch (error) {
		expect(error).toBeInstanceOf(CodeProjectError);
		expect(error).toMatchObject({ file: 'logic.ts', line: 3, column: 21 });
	}
	await expect(
		scripts(
			`export default function register(){helia.defineAction<{price:number}>({name:'buy',arguments:{},run({state}){return state;}});}`
		)
	).rejects.toThrow('함께 지정');
});

it('supports object intersections and literal values including negative numbers', async () => {
	const compiled = await scripts(action("{price:-2|2} & {mode?: 'buy'}"));
	expect((await run(compiled, { price: -2 })).state).toEqual({ gold: 102 });
	await expect(run(compiled, { price: 3 })).rejects.toMatchObject({ code: 'arguments' });
});

it('rejects detached generic instantiations instead of erasing their argument contracts', async () => {
	await expect(
		scripts(
			`const define = helia.defineAction<{price:number}>; export default function register(){define({name:'buy',run({state}){return state;}});}`
		)
	).rejects.toThrow('호출에 직접');
});

it('defaults omitted schemas to closed no-argument definitions for JS and TS Actions and Queries', async () => {
	for (const language of ['javascript', 'typescript']) {
		const input = {
			schema,
			state: { gold: 100 },
			scripts: {
				main: {
					language,
					source: `
helia.defineAction({name:'buy',ai:true,run({state}){state.gold++;return state;}});
helia.defineQuery({name:'read',ai:true,run({state}){return state.gold;}});`
				}
			}
		};
		expect((await evaluateAction({ ...input, action: { name: 'buy', args: {} } })).state).toEqual({
			gold: 101
		});
		await expect(
			evaluateAction({ ...input, action: { name: 'buy', args: { extra: true } } })
		).rejects.toMatchObject({ code: 'arguments' });
		expect(
			(
				await evaluateAction({
					...input,
					action: { name: 'read', args: {} },
					operation: { kind: 'query', name: 'read', args: {} }
				})
			).value
		).toBe(100);
		await expect(
			evaluateAction({
				...input,
				action: { name: 'read', args: {} },
				operation: { kind: 'query', name: 'read', args: { extra: true } }
			})
		).rejects.toMatchObject({ phase: 'arguments' });
	}
});

it('materializes standalone TypeScript scripts too, and still rejects explicitly invalid schemas', async () => {
	const input = {
		schema,
		state: { gold: 100 },
		scripts: {
			main: {
				language: 'typescript',
				source: `
interface Args {price:number}
helia.defineAction<Args>({name:'buy',run({state,args}){state.gold-=args.price;return state;}});`
			}
		}
	};
	expect(
		(await evaluateAction({ ...input, action: { name: 'buy', args: { price: 7 } } })).state
	).toEqual({ gold: 93 });
	await expect(
		evaluateAction({ ...input, action: { name: 'buy', args: { price: '7' } } })
	).rejects.toMatchObject({ code: 'arguments' });
	await expect(
		scripts(
			`export default function register(){helia.defineAction({name:'buy',arguments:null,run({state}){return state;}});}`
		).then((compiled) => run(compiled, {}))
	).rejects.toThrow();
});

it('retains arbitrary standalone script IDs without interpreting them as filesystem paths', async () => {
	const input = {
		schema,
		state: { gold: 100 },
		scripts: {
			'chapter/../buy action': {
				language: 'typescript',
				source: `helia.defineAction<{price:number}>({name:'buy',run({state,args}){state.gold-=args.price;return state;}});`
			}
		},
		action: { name: 'buy', args: { price: 3 } }
	};
	expect((await evaluateAction(input)).state).toEqual({ gold: 97 });
});
