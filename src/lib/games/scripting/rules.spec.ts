import { describe, expect, it } from 'vitest';

import type { ActionRequest } from './protocol.js';

import { evaluateAction } from './engine.js';

const schema = {
	type: 'object',
	properties: { value: { type: 'integer' }, log: { type: 'array', items: { type: 'string' } } },
	required: ['value', 'log'],
	additionalProperties: false
} as const;
const noArgs = `{type:'object',properties:{},additionalProperties:false}`;
export const ACTIONS = `
helia.defineAction({name:'start',arguments:${noArgs},run({state}){state.value++;state.log.push('start');helia.emit('started',{value:state.value});return state;}});
helia.defineAction({name:'bonus',arguments:${noArgs},run({state}){state.value+=10;state.log.push('bonus');return state;}});
helia.defineAction({name:'finish',arguments:${noArgs},run({state}){state.value+=100;state.log.push('finish');return state;}});
`;
export function rulesInput(extra: string): ActionRequest {
	return {
		schema: { ...schema, required: ['value', 'log'] },
		state: { value: 0, log: [] },
		action: { name: 'start', args: {} },
		scripts: { main: { language: 'typescript', source: ACTIONS + extra } }
	};
}
describe('sandboxed Filters and Hooks', () => {
	it('uses locale-independent script ordering to break equal priorities', async () => {
		const input = rulesInput('');
		input.scripts.z = {
			language: 'typescript',
			source: `helia.defineHook({name:'z',actions:['start'],run(){helia.emit('z');}});`
		};
		input.scripts['ä'] = {
			language: 'typescript',
			source: `helia.defineHook({name:'a-umlaut',actions:['start'],run(){helia.emit('a-umlaut');}});`
		};
		expect((await evaluateAction(input)).events?.map((event) => event.name)).toEqual([
			'started',
			'z',
			'a-umlaut'
		]);
	});
});

describe('sandboxed Filters and Hooks', () => {
	it('executes included chains in priority order with accumulated state and immutable trigger context', async () => {
		const result = await evaluateAction(
			rulesInput(`
helia.defineHook({name:'late',priority:10,actions:['start'],run({state,after}) {if(state.value!==111||after.value!==1)throw Error('wrong boundary');helia.emit('late');}});
helia.defineHook({name:'early',priority:-10,actions:['start'],run(){return [{name:'bonus',args:{}}];}});
helia.defineHook({name:'chain',actions:['bonus'],run(){return [{name:'finish',args:{}}];}});
helia.defineFilter({name:'valid',run({before,after,changes,action}){if(!changes.length||!action.name||after.value<before.value)throw Error('invalid context');return {allow:true};}});
`)
		);
		expect(result.state).toEqual({ value: 111, log: ['start', 'bonus', 'finish'] });
		expect(result.events?.map((event) => event.name)).toEqual(['started', 'late']);
	});
});

describe('sandboxed Filters and Hooks', () => {
	it.each([
		[`run(){return {allow:false,reason:'Not allowed'};}`, 'filter-rejected'],
		[`run(){return true;}`, 'filter'],
		[`run({after}){after.value=999;return {allow:true};}`, 'filter'],
		[`run(){try {helia.emit('bad');}catch{} return {allow:true};}`, 'filter']
	])('rejects invalid or denying Filters: %s', async (body, code) => {
		await expect(
			evaluateAction(rulesInput(`helia.defineFilter({name:'guard',${body}});`))
		).rejects.toMatchObject({ code, ruleId: 'guard', scriptId: 'main' });
	});
});

describe('sandboxed Filters and Hooks', () => {
	it('checks the aggregate proposal after included work', async () => {
		await expect(
			evaluateAction(
				rulesInput(`
helia.defineFilter({name:'limit',actions:['start'],run({after}){return {allow:after.value<5,reason:'Too much'};}});
helia.defineHook({name:'bonus',actions:['start'],run(){return [{name:'bonus',args:{}}];}});
`)
			)
		).rejects.toMatchObject({ code: 'filter-rejected', ruleId: 'limit', reason: 'Too much' });
	});
});

describe('sandboxed Filters and Hooks', () => {
	it.each([
		`run(){helia.emit('discard');throw Error('failed');}`,
		`run({state}){state.value=90;}`,
		`run(){return [{name:'missing',args:{}}];}`,
		`run(){return Promise.resolve([]);}`,
		`run(){return {state:{value:10,log:[]}};}`
	])('rejects included Hook failures or invalid requests: %s', async (body) => {
		await expect(
			evaluateAction(rulesInput(`helia.defineHook({name:'bad',actions:['start'],${body}});`))
		).rejects.toThrow();
	});
});

describe('sandboxed Filters and Hooks', () => {
	it('rejects Action reentry and bounds the number of Hook invocations', async () => {
		await expect(
			evaluateAction(
				rulesInput(
					`helia.defineHook({name:'loop',actions:['start'],run(){return [{name:'start',args:{}}];}});`
				)
			)
		).rejects.toMatchObject({ code: 'reentry' });
		const hooks = Array.from(
			{ length: 129 },
			(_, index) => `helia.defineHook({name:'hook${index}',actions:['start'],run(){}});`
		).join('\n');
		await expect(evaluateAction(rulesInput(hooks))).rejects.toMatchObject({ code: 'chain-limit' });
	});
});

describe('sandboxed Filters and Hooks', () => {
	it('rejects deep Action chains without committing a prefix', async () => {
		const chain = Array.from(
			{ length: 18 },
			(_, index) => `
helia.defineAction({name:'step${index}',arguments:${noArgs},run({state}){state.value++;return state;}});
helia.defineHook({name:'h${index}',actions:['${index === 0 ? 'start' : `step${index - 1}`}'],run(){return [{name:'step${index}',args:{}}];}});`
		).join('\n');
		await expect(evaluateAction(rulesInput(chain))).rejects.toMatchObject({ code: 'chain-limit' });
	});
});

describe('sandboxed Filters and Hooks', () => {
	it('defers independent Hooks and only runs the explicitly requested Hook group', async () => {
		const input = rulesInput(
			`helia.defineHook({name:'independent',mode:'independent',actions:['start'],run({before,after,state}){if(before.value!==0||after.value!==1||state.value!==1)throw Error('trigger');helia.emit('independent');return [{name:'bonus',args:{}}];}});`
		);
		const root = await evaluateAction(input);
		expect(root.independentHooks).toEqual(['independent']);
		expect(root.state.value).toBe(1);
		const next = await evaluateAction({
			...input,
			state: root.state,
			action: { name: 'hook:independent', args: {} },
			operation: {
				kind: 'hook',
				name: 'independent',
				trigger: { before: input.state, after: root.state, action: input.action }
			}
		});
		expect(next.state.value).toBe(11);
		expect(next.events?.map((event) => event.name)).toEqual(['independent']);
	});
});

describe('sandboxed Filters and Hooks', () => {
	it('applies rules to host state proposals and does not fire change Hooks on no-op proposals', async () => {
		const input = rulesInput(
			`helia.defineFilter({name:'nonnegative',run({after}){return {allow:after.value>=0};}});helia.defineHook({name:'changes',run(){throw Error('should not run for no-op');}});`
		);
		const action = { name: 'host', args: {} };
		expect(
			(
				await evaluateAction({
					...input,
					action,
					operation: { kind: 'proposal', state: input.state }
				})
			).state
		).toEqual(input.state);
		await expect(
			evaluateAction({
				...input,
				action,
				operation: { kind: 'proposal', state: { value: -1, log: [] } }
			})
		).rejects.toMatchObject({ code: 'filter-rejected' });
	});
});

describe('sandboxed Filters and Hooks', () => {
	it('rejects malformed rule declarations before any Action runs', async () => {
		await expect(
			evaluateAction(rulesInput(`helia.defineHook({name:'unknown',mode:'later',run(){}});`))
		).rejects.toMatchObject({ code: 'registration' });
		await expect(
			evaluateAction(
				rulesInput(`helia.defineFilter({name:'bad',priority:'first',run(){return {allow:true};}});`)
			)
		).rejects.toMatchObject({ code: 'registration' });
	});
});
