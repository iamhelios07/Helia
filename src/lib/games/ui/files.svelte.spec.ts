import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { commands } from 'vitest/browser';

import type {} from '#lib/testing/message-frame-command.js';

import { memoryStorage } from '#lib/testing/memory-storage.js';

import { memorySessionFiles } from '../files/memory.js';
import { createGameRepository } from '../repository-core.js';
import { runCreatorAction } from '../scripting/browser.js';
import MessageContent from './MessageContent.svelte';
import { mountGameUI } from './runtime/bridge.js';

const png =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const image = () =>
	new Blob([Uint8Array.from(atob(png), (char) => char.charCodeAt(0))], { type: 'image/png' });
const disposers: (() => void)[] = [];
afterEach(() => {
	disposers
		.splice(0)
		.reverse()
		.forEach((dispose) => dispose());
	document.querySelectorAll('iframe').forEach((frame) => frame.remove());
});

it('renders persistent Markdown/HTML references and updates deleted media without altering message source', async () => {
	const files = memorySessionFiles();
	const saved = await files.save(image(), { name: 'sword.png' });
	const content = `![Sword](${saved.ref})\n<img src="${saved.ref}" onload="parent.document.body.dataset.bad='yes'">`;
	const view = render(MessageContent, { content, files });
	await expect
		.poll(async () => (await commands.inspectMessageFrame()).images.map((image) => image.width))
		.toEqual([1, 1]);
	expect((await commands.inspectMessageFrame()).html).not.toContain('onload=');
	expect(document.body.dataset.bad).toBeUndefined();
	await files.remove(saved.ref);
	await expect
		.poll(async () => (await commands.inspectMessageFrame()).text)
		.toContain('삭제되었거나');
	expect(
		(await commands.inspectMessageFrame()).images.every((image) => image.hidden && !image.src)
	).toBe(true);
	expect(content).toContain(saved.ref);
	await view.unmount();
	const remount = render(MessageContent, { content, files });
	await expect
		.poll(async () => (await commands.inspectMessageFrame()).text)
		.toContain('삭제되었거나');
	await remount.unmount();
});
it('rejects references from other stores and never hydrates code examples', async () => {
	const owner = memorySessionFiles();
	const saved = await owner.save(image());
	const other = memorySessionFiles();
	const read = vi.spyOn(other, 'read');
	const view = render(MessageContent, { content: `![private](${saved.ref})`, files: other });
	await expect
		.poll(async () => (await commands.inspectMessageFrame()).text)
		.toContain('삭제되었거나');
	await view.rerender({ content: '```html\n<img src="' + saved.ref + '">\n```' });
	await expect.poll(async () => (await commands.inspectMessageFrame()).html).toContain('&lt;img');
	expect(read).toHaveBeenCalledTimes(1);
	await view.unmount();
});
it('ignores a stale file read that completes after deletion', async () => {
	const files = memorySessionFiles();
	const saved = await files.save(image());
	const originalRead = files.read;
	let finish: ((blob: Blob) => void) | undefined;
	const read = vi
		.fn()
		.mockImplementationOnce(
			() =>
				new Promise<Blob>((resolve) => {
					finish = resolve;
				})
		)
		.mockImplementation(originalRead);
	const view = render(MessageContent, {
		content: `![image](${saved.ref})`,
		files: { ...files, read }
	});
	await expect.poll(() => read.mock.calls.length).toBe(1);
	await files.remove(saved.ref);
	await expect
		.poll(async () => (await commands.inspectMessageFrame()).text)
		.toContain('삭제되었거나');
	finish!(image());
	await expect.poll(() => read.mock.settledResults[0]?.type).toBe('fulfilled');
	expect((await commands.inspectMessageFrame()).images[0].src).toBeNull();
	await view.unmount();
});
async function createFileGame(repo: ReturnType<typeof createGameRepository>) {
	const game = await repo.createGame();
	await repo.updateGameRules(game.id, {
		schema: {
			type: 'object',
			properties: { ref: { type: 'string' }, events: { type: 'array', items: { type: 'string' } } },
			required: ['ref', 'events'],
			additionalProperties: false
		},
		initialState: { ref: '', events: [] },
		scripts: {
			main: {
				language: 'typescript',
				source: `helia.defineAction({name:'set',arguments:{type:'object',properties:{ref:{type:'string'}},required:['ref'],additionalProperties:false},run({state,args}){state.ref=args.ref;return state;}});helia.defineAction({name:'event',arguments:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},run({state,args}){state.events.push(args.text);return state;}});`
			}
		},
		ui: {
			version: 1,
			entry: 'ui.tsx',
			modules: {
				'ui.tsx': {
					language: 'tsx',
					source: `
import {storage,useAssetURL,useGameState,registerPanel,action,onDispose} from '@helia/ui';
import {useEffect,useRef} from 'preact/hooks';
function Panel(){const state=useGameState();const asset=useAssetURL(state.ref);const done=useRef(false);useEffect(()=>{if(asset.url&&!done.current){done.current=true;void action('event',{text:'visible'}).then(()=>storage.remove(state.ref));}},[asset.url]);useEffect(()=>{if(asset.error)void action('event',{text:'deleted'});},[asset.error]);return asset.url?<img src={asset.url}/>:<p>{asset.error?'deleted':'loading'}</p>;}
registerPanel({id:'files',title:'Files',component:Panel});
setTimeout(async()=>{if(helia.getState().ref)return;try{
const large=await storage.save(new Blob([new Uint8Array(3*1024*1024)],{type:'application/octet-stream'}),{name:'large.bin'});
if((await storage.read(large.ref)).size!==3*1024*1024)throw Error('bytes');
const saved=await storage.save(new Blob([Uint8Array.from(atob('${png}'),char=>char.charCodeAt(0))],{type:'image/png'}),{name:'image.png'});
if((await storage.stat(saved.ref)).name!=='image.png'||(await storage.list()).files.length!==2)throw Error('metadata');
await action('set',{ref:saved.ref});
}catch(error){await action('event',{text:'failed:'+error.message});}},50);
`
				}
			}
		}
	});
	return game;
}
it('saves binary files through the actual UI bridge, restores them after remount and revokes a deleted image', async () => {
	const files = memorySessionFiles();
	const repo = createGameRepository(memoryStorage(), { runAction: runCreatorAction });
	const game = await createFileGame(repo);
	const iframe = document.createElement('iframe');
	document.body.append(iframe);
	let handle: Awaited<ReturnType<typeof mountGameUI>> | undefined;
	let panels: { id: string }[] = [];
	const views = () =>
		handle?.setViews(
			panels.map((panel) => ({ id: panel.id, x: 0, y: 0, width: 300, height: 200 }))
		);
	handle = await mountGameUI(iframe, game.id, game.activeSessionId, {
		runtime: { ...repo, files, invokeSessionAI: vi.fn() },
		onpanels: (next) => {
			panels = next;
			views();
		}
	});
	disposers.push(handle);
	views();
	await expect
		.poll(
			async () =>
				(await repo.getSessionHistory(game.id, game.activeSessionId)).progress.state.events,
			{ timeout: 15000 }
		)
		.toEqual(['visible', 'deleted']);
	expect((await files.list()).files.map((file) => file.name)).toEqual(['large.bin']);
	handle();
	iframe.remove();
	const next = document.createElement('iframe');
	document.body.append(next);
	const restored = await mountGameUI(next, game.id, game.activeSessionId, {
		runtime: { ...repo, files, invokeSessionAI: vi.fn() },
		onpanels: (info) => {
			panels = info;
			views();
		}
	});
	handle = restored;
	disposers.push(restored);
	views();
	await expect
		.poll(
			async () =>
				(await repo.getSessionHistory(game.id, game.activeSessionId)).progress.state.events,
			{ timeout: 15000 }
		)
		.toEqual(['visible', 'deleted', 'deleted']);
	expect((await files.read((await files.list()).files[0].ref)).size).toBe(3 * 1024 * 1024);
}, 25000);
