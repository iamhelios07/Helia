import '../../../../app.css';
import { expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import { memoryStorage } from '#lib/testing/memory-storage.js';

import type { EditorDiagnostic } from '../../editor-playground.js';
import type { GameState } from '../../state/value.js';

import { compileCodeProject, createCodeProject, type CodeProject } from '../../code-project.js';
import { createGameRepository } from '../../repository-core.js';
import EditorPlayground from '../editor/EditorPlayground.svelte';

it.each(['legacy', 'module', 'converted'])(
	'runs a %s code project as an isolated Preact preview whose button invokes imported QuickJS logic',
	async (startup) => {
		await page.viewport(1200, 800);
		let project = fixtureProject();
		if (startup === 'module') {
			project.files['main.ts'].source =
				"import register from './logic';\nimport './ui';\nimport './ui';\nregister();";
			project.files['ui.tsx'].source =
				"'use ui';\n" +
				project.files['ui.tsx'].source.replace(
					"export default function initialize() { registerPanel({id:'counter',title:'Project counter',component:Panel}); }",
					"registerPanel({id:'counter',title:'Project counter',component:Panel});\nexport default function unused(){throw Error('Default must not be called');}"
				);
		}
		if (startup === 'converted') {
			const previous = await compileCodeProject(project);
			// Games predating source projects store standalone registration scripts, not a project bundle.
			const logic = project.files['logic.ts'].source;
			const body = logic.slice(logic.indexOf('helia.defineAction'), logic.lastIndexOf('}'));
			project = createCodeProject({
				scripts: {
					original: {
						language: 'typescript',
						source: 'const increase = (value:number) => value + 2;\n' + body
					}
				},
				ui: previous.ui
			});
		}
		const compiled = await compileCodeProject(project);
		expect(Object.keys(compiled.scripts)).toEqual(['project']);
		expect(compiled.ui?.entry).toBe(startup === 'legacy' ? 'ui.tsx' : 'helia-ui-entry.ts');
		const repository = createGameRepository(memoryStorage());
		let game = await repository.createGame();
		game = await repository.updateGameRules(game.id, {
			schema: {
				type: 'object',
				properties: {
					value: { type: 'integer' },
					checks: { type: 'array', items: { type: 'string' } }
				},
				required: ['value', 'checks'],
				additionalProperties: false
			},
			initialState: { value: 1, checks: [] },
			...compiled
		});
		let state: GameState = {};
		const diagnostics: EditorDiagnostic[] = [];
		render(EditorPlayground, {
			game: { ...game, code: project },
			mode: 'preview',
			onstate: (next) => (state = next),
			ondiagnostic: (entry) => diagnostics.push(entry)
		});
		await expect
			.poll(() => state, { timeout: 25000 })
			.toEqual({ value: 3, checks: ['Value 3:true:true:undefined:true'] });
		expect(
			document.querySelector('iframe[title="게임 UI 미리보기"]')?.getAttribute('sandbox')
		).toBe('allow-scripts');
		expect(diagnostics.some((entry) => entry.failed)).toBe(false);
		expect(diagnostics.some((entry) => entry.message.includes('트랜잭션'))).toBe(true);
		const original = await repository.getSessionHistory(game.id, game.activeSessionId);
		expect(original.progress.state).toEqual({ value: 1, checks: [] });
		expect(original.transactions).toEqual([]);
	},
	35000
);

function fixtureProject(): CodeProject {
	return {
		version: 1,
		entry: 'main.ts',
		files: {
			'main.ts': {
				language: 'typescript',
				source:
					"export { default as logic } from './logic';\nexport { default as ui } from './ui';\n"
			},
			'shared/math.ts': {
				language: 'typescript',
				source: 'export function increase(value: number): number { return value + 2; }\n'
			},
			'logic.ts': {
				language: 'typescript',
				source: `
import { increase } from './shared/math';
export default function register() {
 helia.defineAction({name:'increment',arguments:{type:'object',properties:{},additionalProperties:false},run({state}){state.value=increase(state.value);return state;}});
 helia.defineAction({name:'inspect',arguments:{type:'object',properties:{label:{type:'string'}},required:['label'],additionalProperties:false},run({state,args}){state.checks.push(args.label);return state;}});
}
`
			},
			'ui.tsx': {
				language: 'tsx',
				source: `
import { h } from 'preact';
import { useEffect } from 'preact/hooks';
import { registerPanel, action, useGameState } from '@helia/ui';
function Panel() {
 const state=useGameState();
 useEffect(()=>{
  const timer=setTimeout(()=>document.querySelector('[data-increment]')?.click(),50);
  return ()=>clearTimeout(timer);
 },[]);
 useEffect(()=>{
  if(state.value!==3)return;
  let hostBlocked=false,storageBlocked=false;
  try{parent.document.body;}catch{hostBlocked=true;}
  try{localStorage.getItem('private');}catch{storageBlocked=true;}
  void action('inspect',{label:[document.querySelector('[data-value]')?.textContent,hostBlocked,storageBlocked,typeof globalThis.__TAURI_INTERNALS__,Object.isFrozen(helia.getState())].join(':')});
 },[state.value]);
 return <div><p data-value>Value {state.value}</p><button data-increment onClick={()=>void action('increment')}>Increase</button></div>;
}
export default function initialize() { registerPanel({id:'counter',title:'Project counter',component:Panel}); }
`
			}
		}
	};
}
