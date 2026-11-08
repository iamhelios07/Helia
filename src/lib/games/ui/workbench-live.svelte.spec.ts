import '../../../app.css';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import AppFixture from '#lib/testing/AppFixture.svelte';

import { createGame, updateGameRules, getSessionHistory } from '../repository.js';
import { workbenchPreferenceKey } from './workbench-preferences.js';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('#lib/storage/transport.js', async () => {
	const { memoryStorage } = await import('#lib/testing/memory-storage.js');
	return { storageRequest: memoryStorage() };
});
afterEach(() => {
	localStorage.clear();
});

it('connects the real Svelte workbench and host geometry to one Preact runtime and cleans up hidden panels', async () => {
	await page.viewport(1280, 900);
	const game = await createGame();
	await updateGameRules(game.id, {
		schema: {
			type: 'object',
			properties: { value: { type: 'integer' }, cleaned: { type: 'boolean' } },
			required: ['value', 'cleaned'],
			additionalProperties: false
		},
		initialState: { value: 0, cleaned: false },
		scripts: {
			main: {
				language: 'javascript',
				source: `
helia.defineAction({name:'increment',arguments:{type:'object',properties:{},additionalProperties:false},run({state}){state.value++;return state;}});
helia.defineAction({name:'cleanup',arguments:{type:'object',properties:{},additionalProperties:false},run({state}){state.cleaned=true;return state;}});
`
			}
		},
		ui: {
			version: 1,
			entry: 'main.tsx',
			modules: {
				'main.tsx': {
					language: 'tsx',
					source: `
import { useEffect } from 'preact/hooks';import { registerPanel,useGameState,action } from '@helia/ui';
function Counter(){return <button data-counter onClick={()=>action('increment').catch(()=>{})}>Add</button>;}
function Summary(){const state=useGameState();useEffect(()=>()=>{void action('cleanup').catch(()=>{});},[]);return <p>{state.value}</p>;}
export default function(){registerPanel({id:'counter',title:'Counter',component:Counter});registerPanel({id:'summary',title:'Summary',component:Summary});const timer=setInterval(()=>{const button=document.querySelector('[data-counter]');if(button){clearInterval(timer);button.click();}},150);return ()=>clearInterval(timer);}
`
				}
			}
		}
	});
	const view = render(AppFixture, { view: 'game', gameId: game.id });
	await expect
		.element(page.getByRole('region', { name: 'Counter 패널', exact: true }))
		.toBeVisible();
	await expect
		.element(page.getByRole('region', { name: 'Summary 패널', exact: true }))
		.toBeVisible();
	expect(document.querySelectorAll('iframe')).toHaveLength(1);
	await expect
		.poll(
			async () => (await getSessionHistory(game.id, game.activeSessionId)).progress.state.value,
			{ timeout: 15_000 }
		)
		.toBe(1);
	await expect.element(page.getByRole('button', { name: '새 세션', exact: true })).toBeEnabled();
	await page.getByRole('button', { name: 'Summary 패널 최소화', exact: true }).click();
	await expect
		.poll(
			async () => (await getSessionHistory(game.id, game.activeSessionId)).progress.state.cleaned,
			{ timeout: 15_000 }
		)
		.toBe(true);
	expect(JSON.parse(localStorage.getItem(workbenchPreferenceKey(game.id))!).hidden).toContain(
		'summary'
	);
	await page.getByLabelText('워크벤치 배치', { exact: true }).click();
	await expect
		.element(page.getByRole('button', { name: 'Summary 패널 열기', exact: true }))
		.toBeVisible();
	await view.unmount();
}, 30_000);
