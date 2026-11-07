import '../../../../app.css';
import { beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { createGameRepository } from '../../repository-core.js';
import { memoryStorage } from '#lib/testing/memory-storage.js';
import type { GameState } from '../../state/value.js';
import type { EditorDiagnostic } from '../../editor-playground.js';
import EditorPlayground from './EditorPlayground.svelte';

beforeEach(async () => {
	localStorage.clear();
	await page.viewport(1000, 800);
});

async function fixture(source?: string) {
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
		initialState: { value: 0, checks: [] },
		scripts: {
			main: {
				language: 'javascript',
				source: `
helia.defineAction({name:'increment',arguments:{type:'object',properties:{},additionalProperties:false},run({state}){state.value++;return state;}});
helia.defineAction({name:'check',arguments:{type:'object',properties:{label:{type:'string'}},required:['label'],additionalProperties:false},run({state,args}){state.checks.push(args.label);return state;}});
helia.defineFilter({name:'limit',run({after}){return {allow:after.value<3,reason:'Maximum reached'};}});
`
			}
		},
		...(source
			? {
					ui: {
						version: 1,
						entry: 'main.tsx',
						modules: { 'main.tsx': { language: 'tsx', source } }
					}
				}
			: {})
	});
	return { game, repository };
}

it('renders real Preact panels and runs their actions in an opaque, isolated preview', async () => {
	const { game, repository } = await fixture(`
import {useEffect} from 'preact/hooks';
import {registerPanel,action,useGameState} from '@helia/ui';
function Panel(){const state=useGameState();useEffect(()=>{void action('increment').then(()=>action('check',{label:document.querySelector('[data-preview]')?.textContent??'missing'}));},[]);return <p data-preview>Preview rendered</p>;}
registerPanel({id:'main',title:'Main',component:Panel});
`);
	let state: GameState = {};
	const diagnostics: EditorDiagnostic[] = [];
	render(EditorPlayground, {
		game,
		mode: 'preview',
		onstate: (next) => (state = next),
		ondiagnostic: (entry) => diagnostics.push(entry)
	});
	await expect
		.poll(() => state, { timeout: 20000 })
		.toEqual({ value: 1, checks: ['Preview rendered'] });
	const frame = document.querySelector('iframe[title="게임 UI 미리보기"]');
	expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
	expect(
		(await repository.getSessionHistory(game.id, game.activeSessionId)).progress.state
	).toEqual({ value: 0, checks: [] });
	expect(diagnostics.some((entry) => entry.message.includes('트랜잭션'))).toBe(true);
}, 25000);

it('preserves test progress after draft edits and switches, then restarts only after modal confirmation', async () => {
	const { game, repository } = await fixture();
	let state: GameState = {};
	const screen = render(EditorPlayground, {
		game,
		mode: 'test',
		onstate: (next) => (state = next)
	});
	await page.getByRole('button', { name: '테스트 시작', exact: true }).click();
	await expect.poll(() => state).toEqual({ value: 0, checks: [] });
	await page.getByText('Action 직접 실행', { exact: true }).click();
	await page.getByRole('combobox', { name: 'Action', exact: true }).fill('increment');
	await page.getByRole('button', { name: 'Action 실행', exact: true }).click();
	await expect.poll(() => state).toEqual({ value: 1, checks: [] });
	const edited = { ...game, initialState: { value: 2, checks: [] } };
	await screen.rerender({ game: edited });
	await expect.element(page.getByText(/현재 테스트는 시작할 때의 내용을 유지합니다/)).toBeVisible();
	expect(state).toEqual({ value: 1, checks: [] });
	await screen.rerender({ mode: 'preview' });
	await expect.poll(() => state).toEqual({ value: 2, checks: [] });
	await screen.rerender({ mode: 'test' });
	await expect.poll(() => state).toEqual({ value: 1, checks: [] });
	await page.getByRole('button', { name: '테스트 다시 시작' }).click();
	await expect.element(page.getByRole('dialog')).toBeVisible();
	await page.getByRole('button', { name: '취소', exact: true }).click();
	expect(state).toEqual({ value: 1, checks: [] });
	await page.getByRole('button', { name: '테스트 다시 시작' }).click();
	await page.getByRole('button', { name: '다시 시작', exact: true }).click();
	await expect.poll(() => state).toEqual({ value: 2, checks: [] });
	expect((await repository.getGameWorkspace(game.id))?.sessions).toHaveLength(1);
}, 20000);

it('reports creator Filter failures while keeping the committed test state and history', async () => {
	const { game } = await fixture();
	const diagnostics: EditorDiagnostic[] = [];
	render(EditorPlayground, {
		game,
		mode: 'test',
		ondiagnostic: (entry) => diagnostics.push(entry)
	});
	await page.getByRole('button', { name: '테스트 시작', exact: true }).click();
	await page.getByText('테스트 상태 · 트랜잭션', { exact: true }).click();
	await page
		.getByRole('textbox', { name: '다음 상태 (JSON)', exact: true })
		.fill('{"value":3,"checks":[]}');
	await page.getByRole('button', { name: '트랜잭션 커밋' }).click();
	await expect.element(page.getByRole('alert')).toHaveTextContent('Maximum reached');
	await expect
		.element(page.getByLabelText('실행 상태', { exact: true }))
		.toHaveTextContent('"value": 0');
	await expect
		.poll(() =>
			diagnostics.some((entry) => entry.failed && entry.detail?.includes('filter-rejected'))
		)
		.toBe(true);
}, 20000);

it('surfaces UI compile failures as diagnostics without mounting privileged content', async () => {
	const { game } = await fixture(
		`import x from 'https://example.com/script.js'; export default function(){}`
	);
	const diagnostic = vi.fn();
	render(EditorPlayground, { game, mode: 'preview', ondiagnostic: diagnostic });
	await expect.element(page.getByRole('alert')).toHaveTextContent('포함된 모듈');
	expect(diagnostic.mock.calls.some(([entry]) => entry.failed)).toBe(true);
	expect(document.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts');
}, 20000);

it('resolves the draft resource snapshot inside a sandboxed Preact image', async () => {
	const { game } = await fixture(`
import {registerPanel,asset,action} from '@helia/ui';
function Panel(){return <img src={asset('portrait')} alt="Portrait" onLoad={()=>void action('check',{label:'image loaded'})}/>;}
registerPanel({id:'main',title:'Image',component:Panel});
`);
	const withResource = {
		...game,
		resources: {
			portrait: {
				name: 'portrait.png',
				mime: 'image/png',
				data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5gAAAABJRU5ErkJggg=='
			}
		}
	};
	let state: GameState = {};
	render(EditorPlayground, {
		game: withResource,
		mode: 'preview',
		onstate: (next) => (state = next)
	});
	await expect.poll(() => state.checks, { timeout: 20000 }).toEqual(['image loaded']);
}, 25000);

it('keeps a preview alive across equivalent draft rerenders', async () => {
	const { game } = await fixture();
	let state: GameState = {};
	const screen = render(EditorPlayground, {
		game,
		mode: 'preview',
		onstate: (next) => (state = next)
	});
	await expect.poll(() => state).toEqual({ value: 0, checks: [] });
	await page.getByText('Action 직접 실행', { exact: true }).click();
	await page.getByRole('combobox', { name: 'Action', exact: true }).fill('increment');
	await page.getByRole('button', { name: 'Action 실행', exact: true }).click();
	await expect.poll(() => state.value).toBe(1);
	await screen.rerender({ game: { ...game, updatedAt: new Date().toISOString() } });
	// Cross the debounce interval through the UI's asynchronous resize/task queue.
	await new Promise((resolve) => setTimeout(resolve, 450));
	expect(state.value).toBe(1);
}, 20000);

it('reports Preact component errors through creator diagnostics', async () => {
	const { game } = await fixture(`
import {registerPanel} from '@helia/ui';
function Broken(){throw Error('Broken creator panel');}
registerPanel({id:'broken',title:'Broken',component:Broken});
`);
	const diagnostics: EditorDiagnostic[] = [];
	render(EditorPlayground, {
		game,
		mode: 'preview',
		ondiagnostic: (entry) => diagnostics.push(entry)
	});
	await expect
		.poll(
			() =>
				diagnostics.some((entry) => entry.failed && entry.detail?.includes('Broken creator panel')),
			{ timeout: 20000 }
		)
		.toBe(true);
}, 25000);
