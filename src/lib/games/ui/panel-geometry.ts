import type { PanelView } from './runtime/model.js';

import { CHAT_PANEL_ID } from './workbench-preferences.js';

export type DockEdge = 'left' | 'right' | 'top' | 'bottom';
export interface PanelDrop {
	target: string;
	edge: DockEdge;
	x: number;
	y: number;
	width: number;
	height: number;
}

export function measurePanelViews(
	bounds: DOMRect,
	bodies: Record<string, HTMLDivElement>,
	expectedIds: string[]
): { views: PanelView[]; chat?: PanelView } {
	const views: PanelView[] = [];
	let chat: PanelView | undefined;
	if (bounds.width <= 0 || bounds.height <= 0) {
		return { views, chat };
	}
	for (const [id, body] of Object.entries(bodies)) {
		if (!expectedIds.includes(id)) {
			continue;
		}
		const rect = body.getBoundingClientRect();
		const x = Math.max(0, rect.left - bounds.left);
		const y = Math.max(0, rect.top - bounds.top);
		const width = Math.min(bounds.width, rect.right - bounds.left) - x;
		const height = Math.min(bounds.height, rect.bottom - bounds.top) - y;
		if (width <= 0 || height <= 0) {
			continue;
		}
		const view = { id, x, y, width, height };
		if (id === CHAT_PANEL_ID) {
			chat = view;
		} else {
			views.push(view);
		}
	}
	return { views, chat };
}

export function panelDropTarget(
	rect: DOMRect,
	bounds: DOMRect,
	pointer: { clientX: number; clientY: number },
	id: string
): PanelDrop | null {
	if (
		pointer.clientX < rect.left ||
		pointer.clientX > rect.right ||
		pointer.clientY < rect.top ||
		pointer.clientY > rect.bottom
	) {
		return null;
	}
	const distances: [DockEdge, number][] = [
		['left', (pointer.clientX - rect.left) / rect.width],
		['right', (rect.right - pointer.clientX) / rect.width],
		['top', (pointer.clientY - rect.top) / rect.height],
		['bottom', (rect.bottom - pointer.clientY) / rect.height]
	];
	const edge = distances.sort((a, b) => a[1] - b[1])[0][0];
	const horizontal = edge === 'left' || edge === 'right';
	return {
		target: id,
		edge,
		x: rect.left - bounds.left + (edge === 'right' ? rect.width / 2 : 0),
		y: rect.top - bounds.top + (edge === 'bottom' ? rect.height / 2 : 0),
		width: rect.width / (horizontal ? 2 : 1),
		height: rect.height / (horizontal ? 1 : 2)
	};
}
