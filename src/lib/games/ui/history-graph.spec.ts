import { expect, it } from 'vitest';

import type { HistoryEvent } from '#lib/games/state/history.js';

import { historyGraph, HISTORY_ROW_HEIGHT } from './history-graph.js';

function event(id: string, parentId: string | null, active = false): HistoryEvent {
	return {
		id,
		parentId,
		active,
		selected: false,
		depth: 0,
		summary: id,
		createdAt: '2026-11-17T00:00:00.000Z',
		action: { name: id, args: {} },
		changes: []
	};
}

it('keeps the active branch straight and draws real forks into separate lanes', () => {
	const events = Object.freeze([
		event('a', null, true),
		event('b', 'a'),
		event('c', 'b'),
		event('d', 'a', true)
	]);
	const graph = historyGraph(events);
	expect(graph.nodes.map((node) => [node.id, node.lane])).toEqual([
		[null, 0],
		['a', 0],
		['d', 0],
		['b', 1],
		['c', 1]
	]);
	expect(graph.edges.map((edge) => [edge.id, edge.active])).toEqual([
		['a', true],
		['d', true],
		['b', false],
		['c', false]
	]);
	expect(graph.edges.find((edge) => edge.id === 'b')?.path).toContain('C');
	expect(graph.edges.find((edge) => edge.id === 'c')?.path).not.toContain('C');
	expect(events.map((event) => event.id)).toEqual(['a', 'b', 'c', 'd']);
});

it('handles an empty history and long unbranched histories without depth-based indentation', () => {
	const initial = historyGraph([]);
	expect(initial.nodes.map((node) => node.id)).toEqual([null]);
	expect(initial.edges).toEqual([]);
	const events = Array.from({ length: 3000 }, (_, index) =>
		event(String(index), index ? String(index - 1) : null, true)
	);
	const graph = historyGraph(events);
	expect(graph.nodes).toHaveLength(3001);
	expect(graph.width).toBe(initial.width);
	expect(graph.height).toBe(3001 * HISTORY_ROW_HEIGHT);
});
