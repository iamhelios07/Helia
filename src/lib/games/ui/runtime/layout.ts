import type { PanelLayout } from './model.js';

export function panelIds(layout: PanelLayout | null): string[] {
	if (!layout) {
		return [];
	}
	if (layout.kind === 'panel') {
		return [layout.id];
	}
	return [...panelIds(layout.first), ...panelIds(layout.second)];
}
export function removePanel(layout: PanelLayout | null, id: string): PanelLayout | null {
	if (!layout || layout.kind === 'panel') {
		return layout?.id === id ? null : layout;
	}
	const first = removePanel(layout.first, id),
		second = removePanel(layout.second, id);
	return first && second ? { ...layout, first, second } : (first ?? second);
}
/** New registrations append without rearranging any surviving player panels. */
export function reconcileLayout(layout: PanelLayout | null, ids: string[]): PanelLayout | null {
	for (const id of panelIds(layout)) {
		if (!ids.includes(id)) {
			layout = removePanel(layout, id);
		}
	}
	for (const id of ids) {
		if (!panelIds(layout).includes(id)) {
			if (!layout) {
				layout = { kind: 'panel', id };
				continue;
			}
			let shallowest = '',
				depth = Infinity;
			function find(node: PanelLayout, level: number) {
				if (node.kind === 'panel') {
					if (level < depth) {
						shallowest = node.id;
						depth = level;
					}
				} else {
					find(node.first, level + 1);
					find(node.second, level + 1);
				}
			}
			find(layout, 0);
			function append(node: PanelLayout): PanelLayout {
				if (node.kind === 'split') {
					return { ...node, first: append(node.first), second: append(node.second) };
				}
				return node.id === shallowest
					? {
							kind: 'split',
							axis: 'horizontal',
							ratio: 0.5,
							first: node,
							second: { kind: 'panel', id }
						}
					: node;
			}
			layout = append(layout);
		}
	}
	return layout;
}
export function dockPanel(
	layout: PanelLayout,
	id: string,
	destination: { id: string; edge: 'left' | 'right' | 'top' | 'bottom'; maxDepth?: number }
): PanelLayout {
	const { id: target, edge, maxDepth = 8 } = destination;
	if (id === target || !panelIds(layout).includes(id) || !panelIds(layout).includes(target)) {
		return layout;
	}
	const remaining = removePanel(layout, id)!;
	function insert(node: PanelLayout): PanelLayout {
		if (node.kind === 'split') {
			return { ...node, first: insert(node.first), second: insert(node.second) };
		}
		if (node.id !== target) {
			return node;
		}
		const leaf: PanelLayout = { kind: 'panel', id };
		return {
			kind: 'split',
			axis: edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical',
			ratio: 0.5,
			first: edge === 'left' || edge === 'top' ? leaf : node,
			second: edge === 'left' || edge === 'top' ? node : leaf
		};
	}
	const next = insert(remaining);
	function depth(node: PanelLayout): number {
		return node.kind === 'panel' ? 0 : 1 + Math.max(depth(node.first), depth(node.second));
	}
	return depth(next) <= maxDepth ? next : layout;
}
