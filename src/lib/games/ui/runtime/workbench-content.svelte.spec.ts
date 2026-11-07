import '../../../../app.css';
import { beforeEach, expect, it, vi } from 'vitest';
import { createRawSnippet } from 'svelte';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import GameWorkbench from '../GameWorkbench.svelte';
import {
	createGame,
	updateGameRules,
	getGameWorkspace,
	getSessionHistory,
	applyGameDraft
} from '#lib/games/repository.js';
import { editorContent } from '#lib/games/editor.js';
import type { GameUI } from './model.js';

vi.mock('#lib/storage/transport.js', async () => {
	const { memoryStorage } = await import('#lib/testing/memory-storage.js');
	return { storageRequest: memoryStorage() };
});
beforeEach(async () => {
	localStorage.clear();
	await page.viewport(1200, 800);
});

function ui(label: string): GameUI {
	return {
		version: 1,
		entry: 'main.tsx',
		modules: {
			'main.tsx': {
				language: 'tsx',
				source: `
import {useEffect} from 'preact/hooks';
import {registerPanel,action} from '@helia/ui';
function Panel(){useEffect(()=>{void action('check',{label:${JSON.stringify(label)}})},[]);return <p>${label}</p>;}
registerPanel({id:'main',title:${JSON.stringify(label)},component:Panel});
`
			}
		}
	};
}

it('loads added UI into an initially chat-only workbench and remounts after later Apply changes', async () => {
	let game = await createGame();
	game = await updateGameRules(game.id, {
		schema: {
			type: 'object',
			properties: { checks: { type: 'array', items: { type: 'string' } } },
			required: ['checks'],
			additionalProperties: false
		},
		initialState: { checks: [] },
		scripts: {
			main: {
				language: 'javascript',
				source: `helia.defineAction({name:'check',arguments:{type:'object',properties:{label:{type:'string'}},required:['label'],additionalProperties:false},run({state,args}){state.checks.push(args.label);return state;}});`
			}
		}
	});
	const screen = render(GameWorkbench, {
		gameId: game.id,
		sessionId: game.activeSessionId,
		ui: game.ui,
		onsavingchange: vi.fn(),
		children: createRawSnippet<[GameUI['chatStyle']]>(() => ({
			render: () => '<div>Chat remains available</div>'
		}))
	});
	screen.container.style.cssText = 'display:flex;width:900px;height:500px';
	const state = async () =>
		(await getSessionHistory(game.id, game.activeSessionId)).progress.state.checks;
	await expect.element(page.getByText('Chat remains available')).toBeVisible();
	await expect.element(page.getByText('게임 화면을 불러오는 중…')).not.toBeInTheDocument();
	let content = editorContent((await getGameWorkspace(game.id))!.game);
	await applyGameDraft(game.id, {
		baseContent: content,
		content: { ...content, ui: ui('Original panel') }
	});
	await expect.poll(state, { timeout: 20000 }).toEqual(['Original panel']);
	const firstFrame = screen.container.querySelector('iframe');
	content = editorContent((await getGameWorkspace(game.id))!.game);
	await applyGameDraft(game.id, {
		baseContent: content,
		content: { ...content, ui: ui('Updated panel') }
	});
	await expect.poll(state, { timeout: 20000 }).toEqual(['Original panel', 'Updated panel']);
	expect(firstFrame?.isConnected).toBe(false);
	content = editorContent((await getGameWorkspace(game.id))!.game);
	await applyGameDraft(game.id, { baseContent: content, content: { ...content, ui: undefined } });
	await expect
		.poll(() => screen.container.querySelector('iframe')?.hasAttribute('srcdoc'))
		.toBe(false);
	await expect.element(page.getByText('Chat remains available')).toBeVisible();
	content = editorContent((await getGameWorkspace(game.id))!.game);
	await applyGameDraft(game.id, {
		baseContent: content,
		content: { ...content, ui: ui('Restored panel') }
	});
	await expect
		.poll(state, { timeout: 20000 })
		.toEqual(['Original panel', 'Updated panel', 'Restored panel']);
}, 60000);
