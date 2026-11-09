import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { invokeSessionAI } from '#lib/games/ai/browser.js';
import {
	createGame,
	createSession,
	getSessionHistory,
	getSessionTimeline,
	updateGameRules
} from '#lib/games/repository.js';

import type { PanelInfo } from './model.js';

import { mountGameUI, type GameUIHandle, type MountOptions } from './bridge.js';

vi.mock('#lib/games/ai/browser.js', () => ({ invokeSessionAI: vi.fn() }));
beforeEach(() => {
	vi.mocked(invokeSessionAI).mockReset();
});

vi.mock('#lib/storage/transport.js', async () => {
	const { memoryStorage } = await import('#lib/testing/memory-storage.js');
	return { storageRequest: memoryStorage() };
});
const disposers: Array<() => void> = [];
afterEach(() => {
	disposers.splice(0).forEach((dispose) => dispose());
	document.querySelectorAll('iframe').forEach((frame) => frame.remove());
	localStorage.clear();
});
const schema = {
	type: 'object',
	properties: { value: { type: 'integer' }, checks: { type: 'array', items: { type: 'string' } } },
	required: ['value', 'checks'],
	additionalProperties: false
} as const;
const scripts = {
	main: {
		language: 'typescript',
		source: `
helia.defineAction({name:'increment',arguments:{type:'object',properties:{},additionalProperties:false},run({state}){state.value++;helia.emit('state.changed',{value:state.value});return state;}});
helia.defineAction({name:'check',arguments:{type:'object',properties:{label:{type:'string'}},required:['label'],additionalProperties:false},run({state,args}){state.checks.push(args.label);return state;}});
`
	}
};
async function setup(source: string) {
	const game = await createGame();
	await updateGameRules(game.id, {
		schema: { ...schema, required: ['value', 'checks'] },
		initialState: { value: 0, checks: [] },
		scripts,
		ui: {
			version: 1,
			entry: 'main.tsx',
			modules: {
				'main.tsx': { language: 'tsx', source },
				'label.tsx': {
					language: 'tsx',
					source: `export default function Label({children}) { return <span data-label>{children}</span>; }`
				}
			}
		}
	});
	return game;
}
async function mount(gameId: string, sessionId: string, options: MountOptions = {}) {
	const iframe = document.createElement('iframe');
	iframe.title = 'Game test';
	document.body.append(iframe);
	const ready = vi.fn(),
		error = vi.fn();
	const runtime: { handle?: GameUIHandle } = {};
	let panels: PanelInfo[] = [];
	const updateViews = () =>
		runtime.handle?.setViews(
			panels.map((panel, index) => ({
				id: panel.id,
				x: 0,
				y: index * 160,
				width: 320,
				height: 155
			}))
		);
	const dispose = await mountGameUI(iframe, gameId, sessionId, {
		...options,
		onready: ready,
		onerror: error,
		onpanels: (next) => {
			panels = next;
			updateViews();
		}
	});
	runtime.handle = dispose;
	updateViews();
	disposers.push(dispose);
	await expect
		.poll(() => ({ ready: ready.mock.calls.length, error: error.mock.calls }), { timeout: 15_000 })
		.toEqual({ ready: 1, error: [] });
	return { iframe, dispose };
}

it('invokes AI only through the explicit custom UI API and resumes UI actions afterward', async () => {
	const game = await setup(`
import { action, registerPanel } from '@helia/ui';
function Panel(){return <p>Explicit AI test</p>;}
export default function(){
 registerPanel({id:'main',title:'Main',component:Panel});
 setTimeout(async()=>{
  await action('increment');
  await action('check',{label:'before-ai'});
  await helia.ai('Inspect the room',{visible:true});
  await action('check',{label:'after-ai:'+helia.getState().value});
 },100);
}`);
	vi.mocked(invokeSessionAI).mockImplementation(async (gameId, sessionId) => {
		const timeline = await getSessionTimeline(gameId, sessionId);
		expect(timeline.history.progress.state).toEqual({ value: 1, checks: ['before-ai'] });
		return timeline;
	});
	await mount(game.id, game.activeSessionId);
	await expect
		.poll(
			async () => (await getSessionHistory(game.id, game.activeSessionId)).progress.state.checks,
			{ timeout: 15_000 }
		)
		.toEqual(['before-ai', 'after-ai:1']);
	expect(invokeSessionAI).toHaveBeenCalledExactlyOnceWith(
		game.id,
		game.activeSessionId,
		{ text: 'Inspect the room', visible: true },
		expect.objectContaining({ signal: expect.any(AbortSignal) })
	);
}, 20_000);

it('aborts an explicit custom UI AI request when its runtime is disposed', async () => {
	const game = await setup(`
export default function(){setTimeout(()=>{void helia.ai('Wait for a response').catch(()=>{});},100);}
`);
	let signal: AbortSignal | undefined;
	vi.mocked(invokeSessionAI).mockImplementation((_game, _session, _input, options) => {
		signal = options?.signal;
		return new Promise((_resolve, reject) =>
			signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
				once: true
			})
		);
	});
	const runtime = await mount(game.id, game.activeSessionId);
	await expect
		.poll(() => vi.mocked(invokeSessionAI).mock.calls.length, { timeout: 15_000 })
		.toBe(1);
	expect(signal?.aborted).toBe(false);
	runtime.dispose();
	expect(signal?.aborted).toBe(true);
	expect((await getSessionHistory(game.id, game.activeSessionId)).transactions).toEqual([]);
}, 20_000);

it('positions and sizes each real iframe panel in the host-provided rectangle', async () => {
	const game = await setup(`
import { registerPanel, action } from '@helia/ui';
function Content(){return <p>Panel content</p>;}
export default function(){
 registerPanel({id:'first',title:'First',component:Content});
 registerPanel({id:'second',title:'Second',component:Content});
 const timer=setInterval(()=>{
   const panels=[...document.querySelectorAll('section.content')];
   if(panels.length!==2)return;
   clearInterval(timer);
   const bounds=panels.map(panel=>{const r=panel.getBoundingClientRect();return [r.x,r.y,r.width,r.height];});
   void action('check',{label:JSON.stringify(bounds)});
 },50);
 return ()=>clearInterval(timer);
}`);
	await mount(game.id, game.activeSessionId);
	await expect
		.poll(
			async () => (await getSessionHistory(game.id, game.activeSessionId)).progress.state.checks,
			// The sandbox compiles TypeScript on first use, so allow for that before the UI reports.
			{ timeout: 10_000 }
		)
		.toEqual(['[[0,0,320,155],[0,160,320,155]]']);
}, 20_000);

it('runs real TSX panels once, shares frozen state/events, and removes component subscriptions', async () => {
	const game = await setup(`
import { useEffect } from 'preact/hooks';
import { registerPanel, useGameState, useUIEvent, useUIState, action } from '@helia/ui';
import Label from './label';
let events=0, cleanups=0;
function Summary(){const state=useGameState();const [event,setEvent]=useUIState('event','none');useUIEvent('state.changed',()=>{events++;setEvent('event');});useEffect(()=>()=>{cleanups++;},[]);return <p data-summary><Label>{state.value+':'+event}</Label></p>;}
function Counter(){return <button data-increment onClick={()=>action('increment').catch(()=>{})}>Increment</button>;}
export default function(){
 registerPanel({id:'counter',title:'Counter',component:Counter});
 const remove=registerPanel({id:'summary',title:'Summary',component:Summary});
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const timer=setTimeout(async()=>{try{
   document.querySelector('[data-increment]').click();
   for(let i=0;i<100&&document.querySelector('[data-summary]')?.textContent!=='1:event';i++)await wait(20);
   await action('check',{label:document.querySelector('[data-summary]')?.textContent+':'+Object.isFrozen(helia.getState())});
   remove();await wait(120);await action('increment');await wait(120);
   await action('check',{label:(document.querySelector('[data-summary]')?'present':'removed')+':'+events+':'+cleanups});
 }catch{await action('check',{label:'failed'}).catch(()=>{});}},250);
 return ()=>clearTimeout(timer);
}`);
	await mount(game.id, game.activeSessionId);
	await expect
		.poll(async () => (await getSessionHistory(game.id, game.activeSessionId)).progress.state, {
			timeout: 15_000
		})
		.toEqual({ value: 2, checks: ['1:event:true', 'removed:1:1'] });
}, 25_000);

it('keeps host DOM, storage and native APIs outside the opaque UI origin and rejects invalid state', async () => {
	const game = await setup(`
import { action, transaction } from '@helia/ui';
export default function(){setTimeout(async()=>{
 let dom=false,storage=false;try{parent.document.body;}catch{dom=true;}try{localStorage.getItem('key');}catch{storage=true;}
 let rejected=false;try{await transaction({name:'invalid',args:{}},{value:'wrong',checks:[]});}catch{rejected=true;}
 await action('check',{label:[dom,storage,typeof globalThis.__TAURI_INTERNALS__,rejected,typeof port,typeof latest].join(':')});
},50);}
`);
	const { iframe } = await mount(game.id, game.activeSessionId);
	expect(iframe.sandbox.value).toBe('allow-scripts');
	await expect
		.poll(async () => (await getSessionHistory(game.id, game.activeSessionId)).progress.state, {
			timeout: 15_000
		})
		.toEqual({ value: 0, checks: ['true:true:undefined:true:undefined:undefined'] });
}, 25_000);

it('restores transient UI State after remount but isolates a different session', async () => {
	const game = await setup(`
import { useEffect } from 'preact/hooks';import { registerPanel,useUIState,action } from '@helia/ui';
function Panel(){const [selected,setSelected]=useUIState('selection','none');useEffect(()=>{void action('check',{label:selected==='none'?'first':'restored'}).then(()=>setSelected('saved'));},[]);return <p>{selected}</p>;}
registerPanel({id:'main',title:'Main',component:Panel});
`);
	const first = await mount(game.id, game.activeSessionId);
	await expect
		.poll(
			async () => (await getSessionHistory(game.id, game.activeSessionId)).progress.state.checks,
			{ timeout: 15_000 }
		)
		.toEqual(['first']);
	await new Promise((resolve) => setTimeout(resolve, 150));
	first.dispose();
	first.iframe.remove();
	await mount(game.id, game.activeSessionId);
	await expect
		.poll(
			async () => (await getSessionHistory(game.id, game.activeSessionId)).progress.state.checks,
			{ timeout: 15_000 }
		)
		.toEqual(['first', 'restored']);
	const second = await createSession(game.id);
	await mount(game.id, second.id);
	await expect
		.poll(async () => (await getSessionHistory(game.id, second.id)).progress.state.checks, {
			timeout: 15_000
		})
		.toEqual(['first']);
}, 30_000);

it('rejects UI writes while the host is blocked and resumes after it becomes available', async () => {
	const game = await setup(`
import { action } from '@helia/ui';
export default function(){setTimeout(async()=>{let denied=false;try{await action('increment');}catch{denied=true;}setTimeout(()=>{void action('check',{label:denied?'blocked':'unexpected'});},350);},50);}
`);
	let blocked = true;
	await mount(game.id, game.activeSessionId, { blocked: () => blocked });
	await new Promise((resolve) => setTimeout(resolve, 250));
	blocked = false;
	await expect
		.poll(async () => (await getSessionHistory(game.id, game.activeSessionId)).progress.state, {
			timeout: 15_000
		})
		.toEqual({ value: 0, checks: ['blocked'] });
}, 25_000);
