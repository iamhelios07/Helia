import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameUI, PanelLayout } from './runtime/model.js';
import { panelIds } from './runtime/layout.js';
import {
	CHAT_PANEL_ID,
	addWorkbenchPanels,
	defaultWorkbenchLayout,
	dockWorkbenchPanel,
	loadWorkbenchPreferences,
	reconcileWorkbenchLayout,
	resetWorkbenchPreferences,
	resizeWorkbenchSplit,
	saveWorkbenchPreferences,
	workbenchPreferenceKey
} from './workbench-preferences.js';

const leaf = (id: string): PanelLayout => ({ kind: 'panel', id });
let stored: Map<string, string>;
beforeEach(() => {
	stored = new Map();
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => stored.get(key) ?? null,
		setItem: (key: string, value: string) => stored.set(key, value),
		removeItem: (key: string) => stored.delete(key)
	});
});
afterEach(() => vi.unstubAllGlobals());

describe('unified workbench layout', () => {
	it('starts with main chat, a right panel and bottom panels in the same tree', () => {
		expect(defaultWorkbenchLayout(undefined, [])).toEqual(leaf(CHAT_PANEL_ID));
		expect(defaultWorkbenchLayout(undefined, ['status', 'controls'])).toEqual({
			kind: 'split',
			axis: 'horizontal',
			ratio: 0.72,
			first: {
				kind: 'split',
				axis: 'vertical',
				ratio: 0.7,
				first: leaf(CHAT_PANEL_ID),
				second: leaf('controls')
			},
			second: leaf('status')
		});
	});
	it('moves any creator panel across chat and moves chat through the same docking operation', () => {
		const tree = defaultWorkbenchLayout(undefined, ['status', 'controls']);
		const moved = dockWorkbenchPanel(tree, 'status', CHAT_PANEL_ID, 'left');
		expect(moved).toMatchObject({
			first: { first: { id: 'status' }, second: { id: CHAT_PANEL_ID } }
		});
		const chatMoved = dockWorkbenchPanel(moved, CHAT_PANEL_ID, 'controls', 'bottom');
		expect(chatMoved).toMatchObject({
			second: { first: { id: 'controls' }, second: { id: CHAT_PANEL_ID } }
		});
		expect(panelIds(chatMoved).sort()).toEqual([CHAT_PANEL_ID, 'controls', 'status'].sort());
	});
	it('keeps the chat main area intact when a new dynamic panel is registered', () => {
		const original = defaultWorkbenchLayout(undefined, ['status']);
		const next = reconcileWorkbenchLayout(original, ['status', 'inventory']);
		expect(next).toMatchObject({
			first: { id: CHAT_PANEL_ID },
			second: { first: { id: 'status' }, second: { id: 'inventory' } }
		});
		expect(original).toEqual(defaultWorkbenchLayout(undefined, ['status']));
		expect(reconcileWorkbenchLayout(next, [])).toEqual(leaf(CHAT_PANEL_ID));
	});
	it('retains hidden and temporarily absent slots when adding a dynamic panel', () => {
		const original = defaultWorkbenchLayout(undefined, ['status', 'controls']);
		const next = addWorkbenchPanels(original, ['status', 'inventory']);
		expect(next).toMatchObject({
			first: { kind: 'split', ratio: 0.7, first: leaf(CHAT_PANEL_ID), second: leaf('controls') },
			second: { first: leaf('status'), second: leaf('inventory') }
		});
		expect(panelIds(next)).toContain('controls');
		expect(addWorkbenchPanels(next, [])).toEqual(next);
		expect(reconcileWorkbenchLayout(next, [])).toEqual(leaf(CHAT_PANEL_ID));
	});
	it('reuses absent slots at capacity while retaining active hidden panels and valid persistence', () => {
		const ids = Array.from({ length: 16 }, (_, index) => `panel${index}`);
		const original = defaultWorkbenchLayout(undefined, ids);
		const next = addWorkbenchPanels(original, [...ids.slice(1), 'new-panel']);
		expect(panelIds(next)).not.toContain('panel0');
		expect(panelIds(next)).toContain('panel1');
		saveWorkbenchPreferences('one', { version: 2, tree: next, hidden: ['panel1'] });
		expect(loadWorkbenchPreferences('one')).toEqual({
			version: 2,
			tree: next,
			hidden: ['panel1']
		});
	});
	it.each([false, true])(
		'maps resize paths past collapsed ancestors (hidden first: %s)',
		(hiddenFirst) => {
			const visible: PanelLayout = {
				kind: 'split',
				axis: 'horizontal',
				ratio: 0.6,
				first: leaf(CHAT_PANEL_ID),
				second: leaf('status')
			};
			const hidden: PanelLayout = {
				kind: 'split',
				axis: 'vertical',
				ratio: 0.3,
				first: leaf('hidden-a'),
				second: leaf('hidden-b')
			};
			const original: PanelLayout = {
				kind: 'split',
				axis: 'vertical',
				ratio: 0.7,
				first: hiddenFirst ? hidden : visible,
				second: hiddenFirst ? visible : hidden
			};
			const next = resizeWorkbenchSplit(original, [], 0.45, [CHAT_PANEL_ID, 'status']);
			expect(next).toEqual({
				...original,
				[hiddenFirst ? 'second' : 'first']: { ...visible, ratio: 0.45 }
			});
			expect(reconcileWorkbenchLayout(next, ['status'])).toEqual({ ...visible, ratio: 0.45 });
		}
	);
	it('maps nested visible resize paths while preserving hidden split ratios and docking edits', () => {
		const original: PanelLayout = {
			kind: 'split',
			axis: 'horizontal',
			ratio: 0.63,
			first: {
				kind: 'split',
				axis: 'vertical',
				ratio: 0.7,
				first: leaf(CHAT_PANEL_ID),
				second: leaf('hidden-a')
			},
			second: {
				kind: 'split',
				axis: 'vertical',
				ratio: 0.4,
				first: leaf('hidden-b'),
				second: {
					kind: 'split',
					axis: 'horizontal',
					ratio: 0.35,
					first: leaf('status'),
					second: leaf('inventory')
				}
			}
		};
		const next = resizeWorkbenchSplit(original, [1], 0.8, [CHAT_PANEL_ID, 'status', 'inventory']);
		expect(next).toMatchObject({
			ratio: 0.63,
			first: original.first,
			second: { ratio: 0.4, first: leaf('hidden-b'), second: { ratio: 0.8 } }
		});
		const moved = dockWorkbenchPanel(next, 'inventory', CHAT_PANEL_ID, 'bottom');
		expect(moved).toMatchObject({
			ratio: 0.63,
			first: { ratio: 0.7, second: leaf('hidden-a') },
			second: { ratio: 0.4, first: leaf('hidden-b'), second: leaf('status') }
		});
		expect(panelIds(moved).sort()).toEqual(panelIds(original).sort());
		expect(reconcileWorkbenchLayout(moved, ['status', 'inventory'])).toEqual({
			kind: 'split',
			axis: 'horizontal',
			ratio: 0.63,
			first: {
				kind: 'split',
				axis: 'vertical',
				ratio: 0.5,
				first: leaf(CHAT_PANEL_ID),
				second: leaf('inventory')
			},
			second: leaf('status')
		});
	});
	it('converts legacy creator defaults without fixing chat outside the movable tree', () => {
		const ui = {
			layout: leaf('status'),
			chatDock: 'bottom',
			chatRatio: 0.3
		} as GameUI;
		const tree = defaultWorkbenchLayout(ui, ['status']);
		expect(tree).toEqual({
			kind: 'split',
			axis: 'vertical',
			ratio: 0.7,
			first: leaf('status'),
			second: leaf(CHAT_PANEL_ID)
		});
		expect(dockWorkbenchPanel(tree, 'status', CHAT_PANEL_ID, 'right')).toMatchObject({
			axis: 'horizontal',
			first: { id: CHAT_PANEL_ID },
			second: { id: 'status' }
		});
	});
	it('persists all sixteen creator panels alongside chat and clamps split sizes', () => {
		const ids = Array.from({ length: 16 }, (_, i) => `panel${i}`);
		const tree = reconcileWorkbenchLayout(leaf(CHAT_PANEL_ID), ids);
		saveWorkbenchPreferences('one', { version: 2, tree, hidden: [] });
		expect(panelIds(loadWorkbenchPreferences('one')!.tree)).toHaveLength(17);
		expect(loadWorkbenchPreferences('two')).toBeUndefined();
		expect(resizeWorkbenchSplit(tree, [], 0.99)).toMatchObject({ ratio: 0.9 });
		expect(resizeWorkbenchSplit(tree, [], NaN)).toBe(tree);
	});
});

describe('workbench preferences', () => {
	it('migrates the two old settings without overwriting them during metadata-only reads', () => {
		const old = JSON.stringify({ chatDock: 'right', chatRatio: 0.4, panelsHidden: true });
		stored.set(workbenchPreferenceKey('game'), old);
		stored.set(
			'helia:panel-layout:game',
			JSON.stringify({ tree: leaf('status'), hidden: ['late'] })
		);
		expect(loadWorkbenchPreferences('game')).toEqual({
			version: 2,
			tree: {
				kind: 'split',
				axis: 'horizontal',
				ratio: 0.6,
				first: leaf('status'),
				second: leaf(CHAT_PANEL_ID)
			},
			hidden: ['late', 'status']
		});
		expect(stored.get(workbenchPreferenceKey('game'))).toBe(old);
		resetWorkbenchPreferences('game');
		expect(stored.size).toBe(0);
	});
	it.each([
		{ tree: leaf('status'), hidden: [] },
		{ tree: leaf(CHAT_PANEL_ID), hidden: [CHAT_PANEL_ID] },
		{ tree: leaf(CHAT_PANEL_ID), hidden: ['bad/id'] },
		{
			tree: {
				kind: 'split',
				axis: 'horizontal',
				ratio: 0.5,
				first: leaf(CHAT_PANEL_ID),
				second: leaf(CHAT_PANEL_ID)
			},
			hidden: []
		},
		{
			tree: {
				kind: 'split',
				axis: 'horizontal',
				ratio: 1.2,
				first: leaf(CHAT_PANEL_ID),
				second: leaf('status')
			},
			hidden: []
		}
	])('ignores invalid local preferences: %j', (value) => {
		stored.set(workbenchPreferenceKey('game'), JSON.stringify({ version: 2, ...value }));
		expect(loadWorkbenchPreferences('game')).toBeUndefined();
	});
	it('continues when device storage is unavailable', () => {
		vi.stubGlobal('localStorage', {
			getItem() {
				throw Error('blocked');
			},
			setItem() {
				throw Error('blocked');
			},
			removeItem() {
				throw Error('blocked');
			}
		});
		expect(loadWorkbenchPreferences('game')).toBeUndefined();
		expect(() =>
			saveWorkbenchPreferences('game', { version: 2, tree: leaf(CHAT_PANEL_ID), hidden: [] })
		).not.toThrow();
		expect(() => resetWorkbenchPreferences('game')).not.toThrow();
	});
});
