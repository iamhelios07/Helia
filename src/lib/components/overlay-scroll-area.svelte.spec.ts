import '../../app.css';
import { createRawSnippet, tick } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';

import OverlayScrollArea from './OverlayScrollArea.svelte';

afterEach(() => vi.restoreAllMocks());

async function fixture(height = 400) {
	const screen = render(OverlayScrollArea, {
		label: '테스트 스크롤',
		maxHeight: '120px',
		children: createRawSnippet(() => ({
			render: () =>
				`<div data-scroll-test style="height:${height}px"><button type="button">내용</button></div>`
		}))
	});
	screen.container.style.width = '300px';
	const viewport = page
		.getByRole('region', { name: '테스트 스크롤', exact: true })
		.element() as HTMLDivElement;
	viewport.focus();
	const bar = page.getByRole('scrollbar', { name: '테스트 스크롤 이동', exact: true });
	if (height > 120) {
		await expect.element(bar).toBeVisible();
	}
	return { screen, viewport, bar };
}

it('keeps content width constant and updates the overlay when content grows and shrinks', async () => {
	const { screen, viewport, bar } = await fixture(30);
	const before = viewport.clientWidth;
	expect(viewport.scrollHeight).toBe(viewport.clientHeight);
	const content = viewport.querySelector<HTMLElement>('[data-scroll-test]')!;
	content.style.height = '400px';
	await expect.element(bar).toBeVisible();
	expect(viewport.clientWidth).toBe(before);
	expect(viewport.offsetWidth - viewport.clientWidth).toBe(0);
	expect(getComputedStyle(viewport).overflowY).toBe('auto');
	expect(getComputedStyle(viewport).touchAction).toBe('auto');
	await expect
		.element(bar)
		.toHaveAttribute('aria-valuemax', String(viewport.scrollHeight - viewport.clientHeight));
	viewport.scrollTop = 140;
	await expect.element(bar).toHaveAttribute('aria-valuenow', '140');
	content.style.height = '30px';
	await expect.element(bar).not.toBeInTheDocument();
	expect(viewport.clientWidth).toBe(before);
	await screen.unmount();
});

it('supports keyboard scrolling on the native viewport and overlay', async () => {
	const { viewport, bar } = await fixture();
	viewport.focus();
	await userEvent.keyboard('{End}');
	await expect.poll(() => viewport.scrollTop).toBe(viewport.scrollHeight - viewport.clientHeight);
	bar.element().focus();
	await userEvent.keyboard('{Home}');
	expect(viewport.scrollTop).toBe(0);
	await userEvent.keyboard('{ArrowDown}');
	expect(viewport.scrollTop).toBe(40);
	await userEvent.keyboard('{PageDown}');
	expect(viewport.scrollTop).toBeGreaterThan(40);
	await userEvent.keyboard('{End}');
	expect(viewport.scrollTop).toBe(viewport.scrollHeight - viewport.clientHeight);
});

it('supports thumb dragging, track clicks and wheel input and releases capture on cancellation', async () => {
	const { viewport, bar } = await fixture();
	const track = bar.element();
	const thumb = track.firstElementChild!;
	const capture = vi.spyOn(track, 'setPointerCapture').mockImplementation(() => {});
	vi.spyOn(track, 'hasPointerCapture').mockReturnValue(true);
	const release = vi.spyOn(track, 'releasePointerCapture').mockImplementation(() => {});
	const rect = track.getBoundingClientRect();
	thumb.dispatchEvent(
		new PointerEvent('pointerdown', {
			bubbles: true,
			pointerId: 7,
			isPrimary: true,
			button: 2,
			clientY: rect.top + 5
		})
	);
	expect(capture).not.toHaveBeenCalled();
	thumb.dispatchEvent(
		new PointerEvent('pointerdown', {
			bubbles: true,
			pointerId: 7,
			isPrimary: true,
			button: 0,
			clientY: rect.top + 5
		})
	);
	track.dispatchEvent(
		new PointerEvent('pointermove', { bubbles: true, pointerId: 7, clientY: rect.bottom })
	);
	expect(viewport.scrollTop).toBe(viewport.scrollHeight - viewport.clientHeight);
	track.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 7 }));
	expect(release).toHaveBeenCalledWith(7);
	viewport.scrollTop = 0;
	viewport.dispatchEvent(new Event('scroll'));
	await tick();
	const wheel = new WheelEvent('wheel', { deltaY: 50, cancelable: true, bubbles: true });
	track.dispatchEvent(wheel);
	expect(viewport.scrollTop).toBe(50);
	expect(wheel.defaultPrevented).toBe(true);
	track.dispatchEvent(
		new PointerEvent('pointerdown', {
			bubbles: true,
			pointerId: 8,
			isPrimary: true,
			button: 0,
			clientY: rect.bottom
		})
	);
	expect(viewport.scrollTop).toBeGreaterThan(200);
	track.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 8 }));
	expect(release).toHaveBeenCalledWith(8);
});

it('releases an active drag when unmounted and remeasures after viewport resize', async () => {
	const { screen, viewport, bar } = await fixture();
	await screen.rerender({ maxHeight: '80px' });
	await expect.poll(() => viewport.clientHeight).toBe(80);
	await expect.element(bar).toHaveAttribute('aria-valuemax', '320');
	const track = bar.element();
	vi.spyOn(track, 'setPointerCapture').mockImplementation(() => {});
	vi.spyOn(track, 'hasPointerCapture').mockReturnValue(true);
	const release = vi.spyOn(track, 'releasePointerCapture').mockImplementation(() => {});
	track.dispatchEvent(
		new PointerEvent('pointerdown', {
			bubbles: true,
			pointerId: 9,
			isPrimary: true,
			button: 0,
			clientY: track.getBoundingClientRect().top
		})
	);
	await screen.unmount();
	expect(release).toHaveBeenCalledWith(9);
});
