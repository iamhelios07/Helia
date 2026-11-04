import '../../../app.css';
import { createRawSnippet } from 'svelte';
import { beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import GameWorkbench from './GameWorkbench.svelte';
import AppFixture from '../../testing/AppFixture.svelte';
import { createGame } from '../repository.js';
import { mountGameUI, type GameUIHandle } from './runtime/bridge.js';
import type { GameUI, PanelInfo, PanelView } from './runtime/model.js';
import {
	CHAT_PANEL_ID,
	defaultWorkbenchLayout,
	workbenchPreferenceKey
} from './workbench-preferences.js';
import { safeChatStyle } from './chat-style.js';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('../../storage/transport.js', async () => {
	const { memoryStorage } = await import('../../testing/memory-storage.js');
	return { storageRequest: memoryStorage() };
});
vi.mock('./runtime/bridge.js', () => ({ mountGameUI: vi.fn() }));
const ui: GameUI = {
	version: 1,
	entry: 'main.tsx',
	modules: {
		'main.tsx': { language: 'tsx', source: 'export default function Game() { return null; }' }
	}
};
const panels: PanelInfo[] = [
	{ id: 'inventory', title: '소지품' },
	{ id: 'status', title: '능력치' }
];
const children = createRawSnippet(() => ({ render: () => '<div>채팅 유지</div>' }));
const onsavingchange = vi.fn();
const setViews = vi.fn<(views: PanelView[]) => void>();
const handle = () => Object.assign(vi.fn(), { setViews });
beforeEach(async () => {
	vi.resetAllMocks();
	localStorage.clear();
	await page.viewport(1280, 900);
	vi.mocked(mountGameUI).mockImplementation(async (_frame, _game, _session, options) => {
		options?.onui?.(ui);
		options?.onpanels?.(panels);
		options?.onready?.();
		return handle();
	});
});
function mount(gameId = 'game-one', sessionId = 'session-one') {
	const screen = render(GameWorkbench, { gameId, sessionId, ui, children, onsavingchange });
	screen.container.style.height = '650px';
	screen.container.style.display = 'flex';
	return screen;
}
function saved(gameId = 'game-one') {
	return JSON.parse(localStorage.getItem(workbenchPreferenceKey(gameId))!);
}
function leaf(id: string) {
	return document.querySelector<HTMLElement>(`[data-leaf-id="${id}"]`)!;
}
function rect(id: string) {
	return leaf(id).getBoundingClientRect();
}
function panelGeometry(id: string) {
	const bounds = rect(id);
	const origin = leaf(id).closest('.panel-surface')!.getBoundingClientRect();
	return {
		left: bounds.left - origin.left,
		top: bounds.top - origin.top,
		width: bounds.width,
		height: bounds.height
	};
}
function options() {
	return vi.mocked(mountGameUI).mock.calls.at(-1)![3]!;
}
async function ready() {
	await expect
		.element(page.getByRole('region', { name: '능력치 패널', exact: true }))
		.toBeVisible();
	await expect.poll(() => setViews.mock.calls.at(-1)?.[0].length).toBe(2);
}
async function layoutMenu() {
	await page.getByLabelText('워크벤치 배치', { exact: true }).click();
}
async function minimize(title: string) {
	await page.getByRole('button', { name: `${title} 패널 최소화`, exact: true }).click();
}
async function dock(title: string, target: string, edge: 'left' | 'right' | 'top' | 'bottom') {
	const handle = page.getByRole('button', { name: `${title} 패널 이동`, exact: true }).element();
	vi.spyOn(handle, 'setPointerCapture').mockImplementation(() => {});
	const source = handle.closest<HTMLElement>('[data-leaf-id]')!.getBoundingClientRect();
	const box = rect(target);
	const point = {
		left: [box.left + 3, box.top + box.height / 2],
		right: [box.right - 3, box.top + box.height / 2],
		top: [box.left + box.width / 2, box.top + 3],
		bottom: [box.left + box.width / 2, box.bottom - 3]
	}[edge];
	handle.dispatchEvent(
		new PointerEvent('pointerdown', {
			bubbles: true,
			pointerId: 9,
			isPrimary: true,
			button: 0,
			clientX: source.left + 30,
			clientY: source.top + 15
		})
	);
	window.dispatchEvent(
		new PointerEvent('pointermove', {
			bubbles: true,
			pointerId: 9,
			clientX: point[0],
			clientY: point[1]
		})
	);
	await expect
		.poll(() => document.querySelector('[data-drop-edge]')?.getAttribute('data-drop-edge'))
		.toBe(edge);
	window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9 }));
}
it('keeps ordinary games on the existing chat without starting the UI bridge', async () => {
	const game = await createGame();
	const screen = render(AppFixture, { view: 'game', gameId: game.id });
	await expect.element(page.getByRole('textbox', { name: '메시지', exact: true })).toBeVisible();
	expect(document.querySelector('iframe[title="게임 패널"]')).toBeNull();
	expect(mountGameUI).not.toHaveBeenCalled();
	await screen.unmount();
});
it('starts with one main chat, right sidebar and bottom panel, with only compact header controls', async () => {
	const screen = mount();
	await ready();
	expect(rect('inventory').left).toBeGreaterThan(rect(CHAT_PANEL_ID).right);
	expect(rect('status').top).toBeGreaterThan(rect(CHAT_PANEL_ID).bottom);
	expect(rect('status').left).toBeCloseTo(rect(CHAT_PANEL_ID).left);
	expect(document.querySelectorAll('iframe')).toHaveLength(1);
	expect(document.querySelector('iframe')!.getAttribute('sandbox')).toBe('allow-scripts');
	expect(document.querySelector('iframe')!.getAttribute('referrerpolicy')).toBe('no-referrer');
	const visibleControls = [...document.querySelectorAll('select')].filter((element) =>
		(element as HTMLElement).checkVisibility()
	);
	expect(visibleControls).toHaveLength(0);
	await page.getByLabelText('워크벤치 배치', { exact: true }).click();
	expect(document.querySelectorAll('select')).toHaveLength(0);
	await userEvent.keyboard('{Escape}');
	expect(document.querySelectorAll('[aria-label="채팅 패널 최소화"]')).toHaveLength(0);
	expect(localStorage.getItem(workbenchPreferenceKey('game-one'))).toBeNull();
	await screen.unmount();
});
it('moves creator panels across the chat boundary and chat itself through the same tree, preserving chat DOM', async () => {
	const screen = mount();
	await ready();
	const content = page.getByText('채팅 유지', { exact: true }).element();
	await dock('소지품', CHAT_PANEL_ID, 'left');
	await expect.poll(() => rect('inventory').right < rect(CHAT_PANEL_ID).left).toBe(true);
	expect(saved().version).toBe(2);
	await dock('채팅', 'inventory', 'bottom');
	await expect.poll(() => rect(CHAT_PANEL_ID).top > rect('inventory').bottom).toBe(true);
	expect(page.getByText('채팅 유지', { exact: true }).element()).toBe(content);
	expect(mountGameUI).toHaveBeenCalledTimes(1);
	await screen.unmount();
});
it('persists one game-specific tree, hiding and reopening panels, and restores defaults', async () => {
	let screen = mount();
	await ready();
	await dock('소지품', CHAT_PANEL_ID, 'left');
	await minimize('능력치');
	expect(saved().hidden).toContain('status');
	const tree = saved().tree;
	await screen.unmount();
	screen = mount();
	await expect
		.element(page.getByRole('region', { name: '소지품 패널', exact: true }))
		.toBeVisible();
	await expect.poll(() => rect('inventory').right < rect(CHAT_PANEL_ID).left).toBe(true);
	expect(saved().tree).toEqual(tree);
	await layoutMenu();
	await page.getByRole('button', { name: '능력치 패널 열기' }).click();
	await ready();
	expect(document.querySelector('[aria-label="채팅 패널 최소화"]')).toBeNull();
	await userEvent.keyboard('{Escape}');
	await layoutMenu();
	await page.getByRole('button', { name: '기본 배치로 복원' }).click();
	expect(localStorage.getItem(workbenchPreferenceKey('game-one'))).toBeNull();
	await expect.poll(() => rect('inventory').left > rect(CHAT_PANEL_ID).right).toBe(true);
	await screen.unmount();
	screen = mount('game-two');
	await ready();
	expect(localStorage.getItem(workbenchPreferenceKey('game-two'))).toBeNull();
	await screen.unmount();
});
it('supports keyboard and pointer split resizing with a shield over the iframe', async () => {
	const screen = mount();
	await ready();
	const slider = document.querySelector<HTMLElement>(
		'[role="slider"][aria-orientation="horizontal"]'
	)!;
	slider.focus();
	await userEvent.keyboard('{Home}');
	expect(saved().tree.ratio).toBe(0.1);
	vi.spyOn(slider, 'setPointerCapture').mockImplementation(() => {});
	slider.dispatchEvent(
		new PointerEvent('pointerdown', {
			bubbles: true,
			pointerId: 7,
			isPrimary: true,
			button: 0,
			clientX: 100
		})
	);
	await expect.poll(() => !!document.querySelector('.interaction-shield')).toBe(true);
	slider.dispatchEvent(
		new PointerEvent('pointermove', { bubbles: true, pointerId: 7, clientX: 10000 })
	);
	await expect.poll(() => slider.getAttribute('aria-valuenow')).toBe('90');
	slider.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7 }));
	expect(saved().tree.ratio).toBe(0.9);
	expect(mountGameUI).toHaveBeenCalledTimes(1);
	await screen.unmount();
});
it('restores minimized panels to their saved geometry and ratios after reopening and remounting', async () => {
	let screen = mount();
	await ready();
	const chat = page.getByText('채팅 유지', { exact: true }).element();
	const slider = document.querySelector<HTMLElement>(
		'[role="slider"][aria-orientation="vertical"]'
	)!;
	slider.focus();
	await userEvent.keyboard('{ArrowUp}');
	await expect.poll(() => saved().tree.first.ratio).toBeCloseTo(0.68);
	const original = saved().tree;
	const { left, top, width, height } = panelGeometry('status');
	await minimize('능력치');
	expect(saved().tree).toEqual(original);
	await expect.poll(() => leaf('status')).toBeNull();
	await layoutMenu();
	await page.getByRole('button', { name: '능력치 패널 열기' }).click();
	await ready();
	await expect.poll(() => panelGeometry('status').top).toBeCloseTo(top);
	expect(panelGeometry('status').left).toBeCloseTo(left);
	expect(panelGeometry('status').width).toBeCloseTo(width);
	expect(panelGeometry('status').height).toBeCloseTo(height);
	expect(saved().tree).toEqual(original);
	expect(page.getByText('채팅 유지', { exact: true }).element()).toBe(chat);
	await minimize('능력치');
	await minimize('소지품');
	expect(saved().tree).toEqual(original);
	await screen.unmount();
	screen = mount();
	await expect.element(page.getByRole('region', { name: '채팅 패널', exact: true })).toBeVisible();
	expect(leaf('inventory')).toBeNull();
	expect(leaf('status')).toBeNull();
	await layoutMenu();
	await page.getByRole('button', { name: '소지품 패널 열기' }).click();
	await expect
		.element(page.getByRole('region', { name: '소지품 패널', exact: true }))
		.toBeVisible();
	await layoutMenu();
	await page.getByRole('button', { name: '능력치 패널 열기' }).click();
	await ready();
	await expect.poll(() => panelGeometry('status').top).toBeCloseTo(top);
	expect(panelGeometry('status').height).toBeCloseTo(height);
	expect(saved().tree).toEqual(original);
	expect(saved().hidden).toEqual([]);
	await screen.unmount();
});
it('preserves hidden placement while resizing collapsed splits and docking other panels', async () => {
	const screen = mount();
	await ready();
	await minimize('소지품');
	const slider = document.querySelector<HTMLElement>(
		'[role="slider"][aria-orientation="vertical"]'
	)!;
	slider.focus();
	await userEvent.keyboard('{Home}');
	expect(saved().tree.ratio).toBe(0.72);
	expect(saved().tree.first.ratio).toBe(0.1);
	await dock('능력치', CHAT_PANEL_ID, 'right');
	expect(saved().tree).toMatchObject({
		ratio: 0.72,
		first: { axis: 'horizontal', first: { id: CHAT_PANEL_ID }, second: { id: 'status' } },
		second: { id: 'inventory' }
	});
	await layoutMenu();
	await page.getByRole('button', { name: '소지품 패널 열기' }).click();
	await ready();
	await expect.poll(() => rect('inventory').left > rect('status').right).toBe(true);
	expect(rect('status').left).toBeGreaterThan(rect(CHAT_PANEL_ID).right);
	expect(saved().tree.ratio).toBe(0.72);
	expect(mountGameUI).toHaveBeenCalledTimes(1);
	await screen.unmount();
});
it('previews header dragging across the iframe, cancels on Escape, and docks on release', async () => {
	const screen = mount();
	await ready();
	const content = page.getByText('채팅 유지', { exact: true }).element();
	const title = page.getByRole('button', { name: '소지품 패널 이동', exact: true }).element();
	vi.spyOn(title, 'setPointerCapture').mockImplementation(() => {});
	const start = () =>
		title.dispatchEvent(
			new PointerEvent('pointerdown', {
				bubbles: true,
				pointerId: 8,
				isPrimary: true,
				button: 0,
				clientX: rect('inventory').left + 30,
				clientY: rect('inventory').top + 15
			})
		);
	const move = () =>
		window.dispatchEvent(
			new PointerEvent('pointermove', {
				bubbles: true,
				pointerId: 8,
				clientX: rect(CHAT_PANEL_ID).left + 3,
				clientY: rect(CHAT_PANEL_ID).top + rect(CHAT_PANEL_ID).height / 2
			})
		);
	start();
	move();
	await expect
		.poll(() => document.querySelector('[data-drop-edge]')?.getAttribute('data-drop-edge'))
		.toBe('left');
	await userEvent.keyboard('{Escape}');
	expect(document.querySelector('.interaction-shield')).toBeNull();
	expect(localStorage.getItem(workbenchPreferenceKey('game-one'))).toBeNull();
	start();
	move();
	window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 8 }));
	await expect.poll(() => rect('inventory').right < rect(CHAT_PANEL_ID).left).toBe(true);
	expect(saved().version).toBe(2);
	expect(page.getByText('채팅 유지', { exact: true }).element()).toBe(content);
	expect(mountGameUI).toHaveBeenCalledTimes(1);
	await screen.unmount();
});
it('measures creator bodies against the full iframe with headers and trusted chat excluded', async () => {
	const screen = mount();
	await ready();
	const frame = document.querySelector('iframe')!.getBoundingClientRect();
	for (const view of setViews.mock.calls.at(-1)![0]) {
		const body = document.querySelector(`[data-panel-body="${view.id}"]`)!.getBoundingClientRect();
		expect(view.x).toBeCloseTo(body.left - frame.left);
		expect(view.y).toBeCloseTo(body.top - frame.top);
		expect(view.width).toBeCloseTo(body.width);
		expect(view.height).toBeCloseTo(body.height);
		expect(view.id).not.toBe(CHAT_PANEL_ID);
	}
	await screen.unmount();
});
it('pins snapshot defaults and registry order while retaining player layout across authored prop changes', async () => {
	const snapshot = { ...ui, chatDock: 'bottom' as const, chatRatio: 0.4 };
	vi.mocked(mountGameUI).mockImplementation(async (_frame, _game, _session, callbacks) => {
		callbacks?.onui?.(snapshot);
		callbacks?.onpanels?.(panels);
		callbacks?.onready?.();
		return handle();
	});
	const screen = mount();
	await ready();
	await dock('소지품', CHAT_PANEL_ID, 'left');
	const player = saved();
	options().onpanels?.([...panels].reverse());
	await screen.rerender({ ui: { ...ui, chatDock: 'left', chatRatio: 0.8 }, blocked: true });
	expect(saved()).toEqual(player);
	expect(mountGameUI).toHaveBeenCalledTimes(1);
	expect(options().blocked?.()).toBe(true);
	await layoutMenu();
	await page.getByRole('button', { name: '기본 배치로 복원' }).click();
	expect(localStorage.getItem(workbenchPreferenceKey('game-one'))).toBeNull();
	await expect.poll(() => rect(CHAT_PANEL_ID).top > rect('inventory').top).toBe(true);
	await screen.unmount();
});
it('preserves saved templates through late/empty registrations and temporary hidden IDs', async () => {
	const savedPrefs = {
		version: 2,
		tree: defaultWorkbenchLayout(ui, ['inventory', 'status']),
		hidden: ['temporary']
	};
	const raw = JSON.stringify(savedPrefs);
	localStorage.setItem(workbenchPreferenceKey('game-one'), raw);
	let resolveMount!: (handle: GameUIHandle) => void;
	vi.mocked(mountGameUI).mockImplementation(
		() =>
			new Promise((resolve) => {
				resolveMount = resolve;
			})
	);
	const screen = mount();
	await expect.poll(() => vi.mocked(mountGameUI).mock.calls.length).toBe(1);
	options().onpanels?.([]);
	expect(localStorage.getItem(workbenchPreferenceKey('game-one'))).toBe(raw);
	options().onui?.(ui);
	options().onpanels?.([...panels, { id: 'temporary', title: '임시' }]);
	options().onready?.();
	resolveMount(handle());
	await ready();
	expect(localStorage.getItem(workbenchPreferenceKey('game-one'))).toBe(raw);
	options().onpanels?.([panels[1]]);
	options().onpanels?.(panels);
	await minimize('소지품');
	expect(saved().hidden).toEqual(['temporary', 'inventory']);
	options().onpanels?.([...panels, { id: 'temporary', title: '임시' }]);
	await layoutMenu();
	await expect.element(page.getByRole('button', { name: '임시 패널 열기' })).toBeVisible();
	await screen.unmount();
});
it('disposes a late session handle and ignores callbacks after unmount', async () => {
	let resolveMount!: (handle: GameUIHandle) => void;
	vi.mocked(mountGameUI).mockImplementation(
		() =>
			new Promise((resolve) => {
				resolveMount = resolve;
			})
	);
	const dispose = handle();
	const screen = mount();
	await expect.poll(() => vi.mocked(mountGameUI).mock.calls.length).toBe(1);
	const callbacks = options();
	await screen.unmount();
	expect(callbacks.blocked?.()).toBe(true);
	resolveMount(dispose);
	await expect.poll(() => dispose.mock.calls.length).toBe(1);
	callbacks.onbusy?.(true);
	expect(onsavingchange).toHaveBeenLastCalledWith(false);
});
it('keeps chat usable with bounded runtime failures and missing snapshot UI, then retries', async () => {
	vi.mocked(mountGameUI).mockRejectedValue(new Error('sensitive compiler detail'));
	const screen = mount();
	await expect.element(page.getByRole('alert')).toHaveTextContent('게임 화면을 불러오지 못했어요.');
	await expect.element(page.getByText('채팅 유지', { exact: true })).toBeVisible();
	expect(document.body.textContent).not.toContain('sensitive compiler detail');
	vi.mocked(mountGameUI).mockImplementation(async (_frame, _game, _session, callbacks) => {
		callbacks?.onui?.(undefined);
		callbacks?.onready?.();
		return handle();
	});
	await page.getByRole('button', { name: '다시 불러오기' }).click();
	await expect.element(page.getByText('채팅 유지', { exact: true })).toBeVisible();
	expect(document.querySelectorAll('[data-leaf-id]')).toHaveLength(1);
	await screen.unmount();
});
it('accepts scoped chat styles and rejects CSS injection and resource references', () => {
	expect(
		safeChatStyle({ color: '#aabbcc', background: 'navy', fontFamily: 'serif' })
	).toMatchObject({ color: '#aabbcc', background: 'navy', fontFamily: 'serif' });
	expect(
		safeChatStyle({
			color: 'var(--secret)',
			background: 'url(https://example.com)',
			fontFamily: 'serif;position:fixed'
		})
	).toMatchObject({ color: undefined, background: undefined, fontFamily: undefined });
});
