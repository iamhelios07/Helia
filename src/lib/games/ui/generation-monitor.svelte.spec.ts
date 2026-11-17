import { afterEach, expect, it, vi } from 'vitest';

import { GenerationMonitor } from './generation-monitor.svelte.js';

const monitors: GenerationMonitor[] = [];
afterEach(() => {
	for (const monitor of monitors.splice(0)) {
		monitor.dispose();
	}
	vi.restoreAllMocks();
});

it('tracks successive requests without exposing text and freezes the cumulative rate on completion', () => {
	let now = 1000;
	vi.spyOn(performance, 'now').mockImplementation(() => now);
	const monitor = new GenerationMonitor();
	monitors.push(monitor);
	monitor.start('First model');
	monitor.receive({ type: 'request', round: 1, attempt: 1 });
	expect(monitor.label).toBe('응답 대기 중');
	monitor.receive({ type: 'activity' });
	expect(monitor.label).toContain('수신 중');
	now = 2000;
	monitor.receive({ type: 'received', kind: 'thinking', characters: 100 });
	expect(monitor.label).toBe('Thinking 수신 중');
	expect(monitor.speed).toBe(100);
	monitor.receive({ type: 'received', kind: 'tool', characters: 10 });
	monitor.receive({ type: 'tool', name: 'craft', status: 'running' });
	expect(monitor.label).toContain('도구 실행 중 · craft');
	monitor.receive({ type: 'request', round: 2, attempt: 1 });
	expect(monitor.label).toBe('다음 응답 대기 중');
	now = 3000;
	monitor.receive({ type: 'received', kind: 'text', characters: 90 });
	monitor.expanded = true;
	monitor.finish();
	expect(monitor.characters).toBe(200);
	expect(monitor.speed).toBe(100);
	expect(monitor.seconds).toBe('2.0');
	expect(monitor.expanded).toBe(false);
	now = 9000;
	monitor.receive({ type: 'received', kind: 'text', characters: 200 });
	monitor.finish();
	expect(monitor.characters).toBe(200);
	expect(monitor.seconds).toBe('2.0');
	monitor.start('Next model');
	expect(monitor.characters).toBe(0);
	expect(monitor.model).toBe('Next model');
	expect(monitor.speed).toBe(0);
});
