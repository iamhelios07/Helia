import { expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { commands, page } from 'vitest/browser';

import type {} from '#lib/testing/message-frame-command.js';

import { MessageFrame } from './message-frame.js';
import MessageContent from './MessageContent.svelte';

it('keeps ordinary text and fenced examples readable without creating a frame', async () => {
	const content = '철 < 은\n```html\n<div>예시</div>\n```';
	const view = render(MessageContent, { content });
	await expect.element(page.getByText('철 < 은', { exact: false })).toHaveTextContent('예시');
	expect(document.querySelector('iframe')).toBeNull();
	await view.unmount();
});

it('keeps unstyled HTML on the dark chat canvas instead of a light iframe canvas', async () => {
	const previous = document.documentElement.style.colorScheme;
	document.documentElement.style.colorScheme = 'dark';
	const view = render(MessageContent, {
		content: '손님 반응<br>잘 쓸게요!',
		appearance: { color: 'rgb(220, 220, 220)' }
	});
	try {
		await expect
			.poll(async () => (await commands.inspectMessageFrame()).text)
			.toContain('잘 쓸게요!');
		expect((await commands.inspectMessageFrame()).documentColorScheme).toBe('dark');
		document.documentElement.style.colorScheme = 'light';
		await view.rerender({ content: '손님 반응<br>다음 주문도 맡길게요!' });
		await expect
			.poll(async () => (await commands.inspectMessageFrame()).documentColorScheme)
			.toBe('light');
	} finally {
		await view.unmount();
		document.documentElement.style.colorScheme = previous;
	}
});

it('renders scoped HTML/CSS and streams into the same iframe with updated appearance', async () => {
	const onresize = vi.fn();
	const view = render(MessageContent, {
		content: '<style>[data-card]{color:rgb(218, 108, 36)}</style><div data-card>철검 주문</div>',
		onresize
	});
	await expect.poll(async () => (await commands.inspectMessageFrame()).text).toContain('철검 주문');
	expect((await commands.inspectMessageFrame()).color).toBe('rgb(218, 108, 36)');
	const frame = document.querySelector('iframe')!;
	expect(frame.contentDocument).toBeNull();
	const source = frame.srcdoc;
	await view.rerender({
		content: '<div>완성된 검</div>',
		appearance: { color: 'rgb(1, 2, 3)', fontFamily: 'monospace' }
	});
	await expect.poll(async () => (await commands.inspectMessageFrame()).text).toBe('완성된 검');
	const rendered = await commands.inspectMessageFrame();
	expect(rendered.color).toBe('rgb(1, 2, 3)');
	expect(rendered.font).toBe('monospace');
	expect(document.querySelector('iframe')).toBe(frame);
	expect(frame.srcdoc).toBe(source);
	await expect.poll(() => onresize.mock.calls.length).toBeGreaterThan(0);
	await view.rerender({ content: '일반 대화로 돌아왔다.' });
	await expect.element(page.getByText('일반 대화로 돌아왔다.')).toBeVisible();
	expect(document.querySelector('iframe')).toBeNull();
	await view.unmount();
});

it('removes executable content and navigation while isolating CSS and host access', async () => {
	const color = getComputedStyle(document.body).color;
	const view = render(MessageContent, {
		content: `
		<style>body{color:rgb(255,0,255)} div{position:fixed;inset:0}</style>
		<div data-card>주문서</div>
		<script>parent.document.body.dataset.compromised='yes'</script>
		<img src="https://example.invalid/leak" onerror="parent.document.body.dataset.compromised='yes'">
		<a href="javascript:alert(1)">링크</a>
		<iframe srcdoc="<script>alert(1)</script>"></iframe>
		<form action="https://example.invalid"><button formaction="https://example.invalid">전송</button></form>
		<meta http-equiv="refresh" content="0;url=https://example.invalid">
	`
	});
	await expect.poll(async () => (await commands.inspectMessageFrame()).text).toContain('주문서');
	const snapshot = await commands.inspectMessageFrame();
	expect(snapshot.html).not.toMatch(/<script|<iframe|<form|<meta|onerror|href=|formaction=/i);
	expect(snapshot.isolated).toBe(true);
	expect(snapshot.policy).toContain("default-src 'none'");
	expect(snapshot.policy).toContain('img-src data:');
	expect(getComputedStyle(document.body).color).toBe(color);
	expect(document.body.dataset.compromised).toBeUndefined();
	expect(document.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts');
	await view.unmount();
});

it('resizes for disclosure changes and caps very tall messages', async () => {
	const view = render(MessageContent, {
		content: '<details><summary>제작 내역</summary><div style="height:400px">철 3개</div></details>'
	});
	await expect.poll(async () => (await commands.inspectMessageFrame()).text).toContain('철 3개');
	const frame = document.querySelector('iframe')!;
	await expect.poll(() => frame.getBoundingClientRect().height).toBeGreaterThan(20);
	await commands.inspectMessageFrame(true);
	await expect.poll(() => frame.getBoundingClientRect().height).toBeGreaterThan(400);
	await view.rerender({ content: '<div style="height:5000px">긴 주문서</div>' });
	await expect.poll(() => frame.getBoundingClientRect().height).toBe(2400);
	await view.unmount();
});

it('reports startup failure once and cancels the timeout on disposal', () => {
	vi.useFakeTimers();
	try {
		const failed = vi.fn();
		const frame = new MessageFrame(document.createElement('iframe'), failed);
		vi.advanceTimersByTime(5000);
		expect(failed).toHaveBeenCalledTimes(1);
		frame.dispose();
		const disposed = new MessageFrame(document.createElement('iframe'), failed);
		disposed.dispose();
		vi.advanceTimersByTime(5000);
		expect(failed).toHaveBeenCalledTimes(1);
	} finally {
		vi.useRealTimers();
	}
});
