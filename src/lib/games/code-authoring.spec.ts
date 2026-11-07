import { expect, it } from 'vitest';
import { diagnoseCode, readAuthoringBundle, writeAuthoringBundle } from './code-authoring.js';

it('edits decoded source without escaping it and preserves UI presentation options', () => {
	const source = `const label = "a\\nb";\nconst close = '</script>';\n`;
	const input = JSON.stringify({
		version: 1,
		entry: 'main.tsx',
		modules: { 'main.tsx': { language: 'tsx', source } },
		chatDock: 'bottom',
		chatRatio: 0.4,
		chatStyle: { color: '#fff' },
		layout: { kind: 'panel', id: 'main' }
	});
	const bundle = readAuthoringBundle(input, 'ui')!;
	expect(bundle.modules['main.tsx'].source).toBe(source);
	const result = JSON.parse(
		writeAuthoringBundle(bundle, 'ui', {
			...bundle.modules,
			'main.tsx': { language: 'tsx', source: source + '// changed\n' }
		})
	);
	expect(result.modules['main.tsx'].source).toBe(source + '// changed\n');
	expect(result).toMatchObject({
		chatDock: 'bottom',
		chatRatio: 0.4,
		chatStyle: { color: '#fff' },
		layout: { kind: 'panel', id: 'main' }
	});
	expect(() => readAuthoringBundle('{unfinished', 'ui')).toThrow();
	expect(readAuthoringBundle('null', 'ui')).toBeNull();
});

it('diagnoses script state access using the current generated schema types', async () => {
	const modules = {
		main: {
			language: 'typescript',
			source: `helia.defineAction({name:'gain',arguments:{},run({state}) { state.gold += 1; state.gold = 'wrong'; state.missing = 1; return state; }});`
		}
	};
	const items = await diagnoseCode(modules, 'export type GameState = { gold: number };\n');
	expect(
		items.some((item) => item.message.includes("Type 'string' is not assignable to type 'number'"))
	).toBe(true);
	expect(items.some((item) => item.message.includes("Property 'missing' does not exist"))).toBe(
		true
	);
	expect(items.every((item) => item.module === 'main' && item.line > 0 && item.column > 0)).toBe(
		true
	);
});

it('resolves generated types and packaged UI modules without executing source', async () => {
	const modules = {
		'main.tsx': {
			language: 'tsx',
			source: `import type { GameState } from '@helia/state';\nimport { useGameState, registerPanel } from '@helia/ui';\nimport { label } from './labels';\nfunction Panel() { const state = useGameState(); return <span>{label}: {state.gold}</span>; }\nexport default function initialize() { return registerPanel({ id: 'status', title:'Status', component:Panel }); }`
		},
		'labels.ts': { language: 'typescript', source: `export const label: string = 'Gold';` }
	};
	expect(await diagnoseCode(modules, 'export type GameState = { gold: number };\n')).toEqual([]);
	const changed = {
		...modules,
		'labels.ts': { language: 'typescript', source: `export const label: number = 'Gold';` }
	};
	expect(
		(await diagnoseCode(changed, 'export type GameState = { gold: number };\n')).some(
			(item) => item.module === 'labels.ts'
		)
	).toBe(true);
});

it('keeps explicitly named modules distinct and recognizes modern standard collection APIs', async () => {
	const items = await diagnoseCode(
		{
			'main.ts': {
				language: 'typescript',
				source:
					"export const good = Object.entries({gold: 1}).map(([key]) => key).includes('gold');\nexport const wrong: number = 'wrong';"
			},
			'main.js': {
				language: 'typescript',
				source: 'export const other = new Map<string, number>();\n'
			}
		},
		'export type GameState = {};\n'
	);
	expect(items).toHaveLength(1);
	expect(items[0]).toMatchObject({ module: 'main.ts' });
	expect(items[0].message).toContain("Type 'string' is not assignable to type 'number'");
});

it('checks each script in its own scope as the sandbox executes it', async () => {
	expect(
		await diagnoseCode(
			{
				first: {
					language: 'typescript',
					source: 'const label = "First";\nconst state: GameState = { gold: 1 };'
				},
				second: {
					language: 'typescript',
					source: 'const label = "Second";\nconst state: GameState = { gold: 2 };'
				}
			},
			'export type GameState = { gold: number };\n'
		)
	).toEqual([]);
});
