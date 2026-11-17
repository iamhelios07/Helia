import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

import '../../../app.css';
import { GenerationMonitor } from './generation-monitor.svelte.js';
import GenerationStatus from './GenerationStatus.svelte';

afterEach(() => vi.restoreAllMocks());

it.each([320, 1100])('keeps the status card and its controls readable at %ipx', async (width) => {
	await page.viewport(width, 800);
	let now = 0;
	vi.spyOn(performance, 'now').mockImplementation(() => now);
	const monitor = new GenerationMonitor();
	monitor.start('DeepSeek V4.1 Flash · A very long model name');
	now = 42800;
	monitor.receive({ type: 'request', round: 2, attempt: 1 });
	monitor.receive({ type: 'received', kind: 'thinking', characters: 1745 });
	const stop = vi.fn();
	const view = render(GenerationStatus, {
		monitor,
		status: 'generating',
		label: '응답 생성 중',
		tools: [{ id: 0, name: 'resolveForge', status: 'completed' }],
		thinking: '과거의 제작 기록을 살펴보고 손님의 주문을 판단합니다.\n'.repeat(100),
		progressText: '',
		onstop: stop
	});
	try {
		const card = page.getByRole('complementary', { name: 'AI 생성 진행' });
		await expect.element(card).toBeVisible();
		await expect.element(card.getByRole('status')).toHaveTextContent('Thinking 수신 중');
		await expect.element(card.getByLabelText('생성 통계')).toHaveTextContent('42.8초');
		await expect.element(card.getByLabelText('생성 통계')).toHaveTextContent('1,745자');
		await expect.element(card.getByLabelText('생성 통계')).toHaveTextContent('41 c/s');
		const bounds = card.element().getBoundingClientRect();
		expect(bounds.left).toBeGreaterThanOrEqual(0);
		expect(bounds.right).toBeLessThanOrEqual(width);
		expect(card.element().scrollWidth).toBeLessThanOrEqual(Math.ceil(bounds.width));
		if (import.meta.env.VITE_CAPTURE_GENERATION_STATUS === '1') {
			await card.screenshot({
				path: `../../../../data/verification/generation-status/card-${width}.png`
			});
		}
		await card.getByRole('button', { name: '생성 상세 정보' }).click();
		await card.getByText('Thinking', { exact: true }).click();
		expect(card.element().getBoundingClientRect().height).toBeLessThan(350);
		await card.getByRole('button', { name: '생성 중지' }).click();
		expect(stop).toHaveBeenCalledOnce();
	} finally {
		monitor.dispose();
		await view.unmount();
	}
});
