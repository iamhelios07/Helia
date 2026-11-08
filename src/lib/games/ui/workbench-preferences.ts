import { dockPanel, panelIds, reconcileLayout, removePanel } from './runtime/layout.js';
import { parsePanelLayout, UI_LIMITS, type GameUI, type PanelLayout } from './runtime/model.js';

/** Creator panel IDs cannot contain '$', so the trusted chat cannot be impersonated. */
export const CHAT_PANEL_ID = '$chat';
export interface WorkbenchPreferences {
	version: 2;
	tree: PanelLayout;
	hidden: string[];
}
type DockEdge = 'left' | 'right' | 'top' | 'bottom';
const chat = (): PanelLayout => ({ kind: 'panel', id: CHAT_PANEL_ID });
const isPanelId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,80}$/.test(id);

export function workbenchPreferenceKey(gameId: string): string {
	return `helia:workbench:${encodeURIComponent(gameId)}`;
}

function besideChat(panels: PanelLayout | null, dock: DockEdge, ratio: number): PanelLayout {
	if (!panels) {
		return chat();
	}
	const first = dock === 'left' || dock === 'top';
	return {
		kind: 'split',
		axis: dock === 'left' || dock === 'right' ? 'horizontal' : 'vertical',
		ratio: first ? ratio : 1 - ratio,
		first: first ? chat() : panels,
		second: first ? panels : chat()
	};
}

/** Legacy creator defaults still work, but all resulting leaves share one movable tree. */
export function defaultWorkbenchLayout(ui: GameUI | undefined, ids: string[]): PanelLayout {
	if (!ids.length) {
		return chat();
	}
	if (ui?.layout || ui?.chatDock || ui?.chatRatio !== undefined) {
		return besideChat(
			reconcileLayout(ui.layout ?? null, ids),
			ui.chatDock ?? 'left',
			ui.chatRatio ?? 0.72
		);
	}
	const bottom = reconcileLayout(null, ids.slice(1));
	return {
		kind: 'split',
		axis: 'horizontal',
		ratio: 0.72,
		first: bottom
			? { kind: 'split', axis: 'vertical', ratio: 0.7, first: chat(), second: bottom }
			: chat(),
		second: { kind: 'panel', id: ids[0] }
	};
}

/** Registration changes affect the visible tree, never overwrite the player's saved template. */
export function reconcileWorkbenchLayout(tree: PanelLayout, ids: string[]): PanelLayout {
	const visible = [CHAT_PANEL_ID, ...ids];
	let next: PanelLayout | null = tree;
	for (const id of panelIds(tree)) {
		if (!visible.includes(id)) {
			next = removePanel(next, id);
		}
	}
	return addWorkbenchPanels(next ?? chat(), ids);
}

/** Keep saved slots for hidden or temporarily absent registrations when adding new panels. */
export function addWorkbenchPanels(tree: PanelLayout, ids: string[]): PanelLayout {
	let next = tree;
	if (!panelIds(next).includes(CHAT_PANEL_ID)) {
		next = besideChat(next, 'left', 0.72);
	}
	for (const id of ids) {
		if (panelIds(next).includes(id)) {
			continue;
		}
		// At capacity, reuse an absent registration's slot budget, never an active hidden panel's.
		if (panelIds(next).length >= UI_LIMITS.panels + 1) {
			const absent = panelIds(next).find(
				(saved) => saved !== CHAT_PANEL_ID && !ids.includes(saved)
			);
			if (!absent) {
				continue;
			}
			next = removePanel(next, absent)!;
		}
		// Prefer existing side/bottom panels so registration does not subdivide the main chat.
		let target = CHAT_PANEL_ID;
		let shallowest = Infinity;
		function find(node: PanelLayout, depth: number) {
			if (node.kind === 'panel') {
				if (node.id !== CHAT_PANEL_ID && depth < shallowest) {
					target = node.id;
					shallowest = depth;
				}
			} else {
				find(node.first, depth + 1);
				find(node.second, depth + 1);
			}
		}
		find(next, 0);
		function append(node: PanelLayout): PanelLayout {
			if (node.kind === 'split') {
				return { ...node, first: append(node.first), second: append(node.second) };
			}
			return node.id === target
				? {
						kind: 'split',
						axis: target === CHAT_PANEL_ID ? 'horizontal' : 'vertical',
						ratio: target === CHAT_PANEL_ID ? 0.72 : 0.5,
						first: node,
						second: { kind: 'panel', id }
					}
				: node;
		}
		next = append(next);
	}
	return next;
}

export function dockWorkbenchPanel(
	tree: PanelLayout,
	id: string,
	target: string,
	edge: DockEdge
): PanelLayout {
	return dockPanel(tree, id, { id: target, edge, maxDepth: 9 });
}

export function resizeWorkbenchSplit(
	tree: PanelLayout,
	path: number[],
	ratio: number,
	visibleIds: string[] = panelIds(tree)
): PanelLayout {
	if (!Number.isFinite(ratio)) {
		return tree;
	}
	const visible = new Set(visibleIds);
	const hasVisible = (node: PanelLayout) => panelIds(node).some((id) => visible.has(id));
	function resize(node: PanelLayout, remaining: number[]): PanelLayout {
		if (node.kind !== 'split') {
			return node;
		}
		const firstVisible = hasVisible(node.first),
			secondVisible = hasVisible(node.second);
		// A collapsed split consumes no path segment in the visible tree.
		if (!firstVisible && !secondVisible) {
			return node;
		}
		if (!firstVisible) {
			return { ...node, second: resize(node.second, remaining) };
		}
		if (!secondVisible) {
			return { ...node, first: resize(node.first, remaining) };
		}
		if (!remaining.length) {
			return { ...node, ratio: Math.max(0.1, Math.min(0.9, ratio)) };
		}
		const [branch, ...rest] = remaining;
		if (branch !== 0 && branch !== 1) {
			return node;
		}
		return branch === 0
			? { ...node, first: resize(node.first, rest) }
			: { ...node, second: resize(node.second, rest) };
	}
	return resize(tree, path);
}

function parseTree(input: unknown): PanelLayout {
	const seen = new Set<string>();
	function visit(value: unknown, depth: number): PanelLayout {
		if (depth > 9 || !value || typeof value !== 'object' || Array.isArray(value)) {
			throw Error('Invalid workbench layout');
		}
		const node = value as Record<string, unknown>;
		if (node.kind === 'panel') {
			if (
				(node.id !== CHAT_PANEL_ID && !isPanelId(node.id)) ||
				seen.has(node.id as string) ||
				seen.size >= 17
			) {
				throw Error('Invalid workbench panel');
			}
			seen.add(node.id as string);
			return { kind: 'panel', id: node.id as string };
		}
		if (
			node.kind !== 'split' ||
			(node.axis !== 'horizontal' && node.axis !== 'vertical') ||
			typeof node.ratio !== 'number' ||
			!Number.isFinite(node.ratio) ||
			node.ratio < 0.1 ||
			node.ratio > 0.9
		) {
			throw Error('Invalid workbench split');
		}
		return {
			kind: 'split',
			axis: node.axis,
			ratio: node.ratio,
			first: visit(node.first, depth + 1),
			second: visit(node.second, depth + 1)
		};
	}
	const tree = visit(input, 0);
	if (!seen.has(CHAT_PANEL_ID)) {
		throw Error('Chat must remain available');
	}
	return tree;
}

function hiddenIds(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 256 || !value.every(isPanelId)) {
		throw Error('Invalid hidden panels');
	}
	return [...new Set(value)];
}

export function loadWorkbenchPreferences(gameId: string): WorkbenchPreferences | undefined {
	try {
		const raw = localStorage.getItem(workbenchPreferenceKey(gameId));
		const saved: unknown = raw === null ? undefined : JSON.parse(raw);
		if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
			const input = saved as Record<string, unknown>;
			if (input.version === 2) {
				return { version: 2, tree: parseTree(input.tree), hidden: hiddenIds(input.hidden) };
			}
		}
		return loadLegacyPreferences(gameId, saved);
	} catch {
		return undefined;
	}
}

/** Read former preferences together; write version 2 only on player edits. */
function loadLegacyPreferences(gameId: string, saved: unknown): WorkbenchPreferences | undefined {
	const oldPanels = localStorage.getItem(`helia:panel-layout:${gameId}`);
	if (!oldPanels && !saved) {
		return undefined;
	}
	const panels: unknown = oldPanels ? JSON.parse(oldPanels) : {};
	if (!panels || typeof panels !== 'object' || Array.isArray(panels)) {
		return undefined;
	}
	const panelInput = panels as Record<string, unknown>;
	const tree = panelInput.tree == null ? null : parsePanelLayout(panelInput.tree);
	const hidden = panelInput.hidden === undefined ? [] : hiddenIds(panelInput.hidden);
	const old = saved && typeof saved === 'object' ? (saved as Record<string, unknown>) : {};
	const dock = ['left', 'right', 'top', 'bottom'].includes(String(old.chatDock))
		? (old.chatDock as DockEdge)
		: 'left';
	const ratio =
		typeof old.chatRatio === 'number' && Number.isFinite(old.chatRatio)
			? Math.max(0.2, Math.min(0.8, old.chatRatio))
			: 0.6;
	return {
		version: 2,
		tree: besideChat(tree, dock, ratio),
		hidden: old.panelsHidden === true ? [...new Set([...hidden, ...panelIds(tree)])] : hidden
	};
}

export function saveWorkbenchPreferences(gameId: string, preferences: WorkbenchPreferences): void {
	try {
		localStorage.setItem(workbenchPreferenceKey(gameId), JSON.stringify(preferences));
	} catch {
		// Device preferences must not interrupt playing or undo game transactions.
	}
}

export function resetWorkbenchPreferences(gameId: string): void {
	try {
		localStorage.removeItem(workbenchPreferenceKey(gameId));
		localStorage.removeItem(`helia:panel-layout:${gameId}`);
	} catch {
		// The visible layout can still reset when storage is unavailable.
	}
}
