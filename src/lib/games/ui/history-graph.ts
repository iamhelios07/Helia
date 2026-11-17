import type { HistoryEvent } from '#lib/games/state/history.js';

export const HISTORY_ROW_HEIGHT = 68;
const x = (lane: number) => 14 + lane * 16;
const y = (index: number) => 34 + index * HISTORY_ROW_HEIGHT;
export interface HistoryGraphNode {
	id: string | null;
	event?: HistoryEvent;
	lane: number;
	cx: number;
	cy: number;
}
export interface HistoryGraphEdge {
	id: string;
	path: string;
	active: boolean;
}

/** Continue straight through a path; allocate lanes only at actual forks. */
export function historyGraph(events: readonly HistoryEvent[]) {
	const children = new Map<string | null, HistoryEvent[]>();
	for (const event of events) {
		const siblings = children.get(event.parentId) ?? [];
		siblings.push(event);
		children.set(event.parentId, siblings);
	}
	const nodes: HistoryGraphNode[] = [{ id: null, lane: 0, cx: x(0), cy: y(0) }];
	const edges: HistoryGraphEdge[] = [];
	let lanes = 1;
	const stack: { parent: HistoryGraphNode; event: HistoryEvent; lane: number }[] = [];
	const enqueue = (parent: HistoryGraphNode) => {
		const ordered = [...(children.get(parent.id) ?? [])].sort(
			(a, b) => Number(b.active) - Number(a.active)
		);
		const pending = ordered.map((event, index) => ({
			parent,
			event,
			lane: index === 0 ? parent.lane : lanes++
		}));
		stack.push(...pending.reverse());
	};
	enqueue(nodes[0]);
	const visited = new Set<string>();
	while (stack.length) {
		const { parent, event, lane } = stack.pop()!;
		if (visited.has(event.id)) {
			continue;
		}
		visited.add(event.id);
		const node = { id: event.id, event, lane, cx: x(lane), cy: y(nodes.length) };
		edges.push({
			id: event.id,
			active: event.active,
			path:
				lane === parent.lane
					? `M ${parent.cx} ${parent.cy} V ${node.cy}`
					: `M ${parent.cx} ${parent.cy} C ${parent.cx} ${parent.cy + 24}, ${node.cx} ${parent.cy + 12}, ${node.cx} ${parent.cy + 34} V ${node.cy}`
		});
		nodes.push(node);
		enqueue(node);
	}
	return { nodes, edges, width: x(lanes - 1) + 14, height: nodes.length * HISTORY_ROW_HEIGHT };
}
