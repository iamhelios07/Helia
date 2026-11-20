function clamp(value: number, maximum: number) {
	return Math.max(0, Math.min(maximum, value));
}

/** Native scrolling owns position; the overlay only measures it and provides drag controls. */
export class OverlayScrollController {
	position = $state(0);
	maximum = $state(0);
	thumbSize = $state(0);
	thumbOffset = $state(0);
	active = $state(false);
	dragging = $state(false);
	private viewport: HTMLElement | undefined;
	private track: HTMLElement | undefined;
	private travel = 0;
	private drag: { id: number; y: number; position: number } | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private measure = () => {
		const viewport = this.viewport;
		if (!viewport || !this.track) {
			return;
		}
		this.maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
		this.position = clamp(viewport.scrollTop, this.maximum);
		const length = this.track.clientHeight;
		this.thumbSize = Math.min(
			length,
			Math.max(28, (length * viewport.clientHeight) / Math.max(1, viewport.scrollHeight))
		);
		this.travel = Math.max(0, length - this.thumbSize);
		this.thumbOffset = this.maximum ? (this.travel * this.position) / this.maximum : 0;
	};
	private reveal = () => {
		this.active = true;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.active = false;
		}, 1000);
	};
	private scroll = () => {
		this.measure();
		this.reveal();
	};
	private move(position: number) {
		if (!this.viewport) {
			return;
		}
		this.viewport.scrollTop = clamp(position, this.maximum);
		this.measure();
		this.reveal();
	}
	private wheel = (event: WheelEvent) => {
		if (!this.viewport || event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
			return;
		}
		const before = this.viewport.scrollTop;
		let scale = 1;
		if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
			scale = 20;
		}
		if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
			scale = this.viewport.clientHeight;
		}
		this.move(before + event.deltaY * scale);
		if (this.viewport.scrollTop !== before) {
			event.preventDefault();
		}
	};
	keydown = (event: KeyboardEvent) => {
		const page = (this.viewport?.clientHeight ?? 0) * 0.9;
		const positions: Record<string, number> = {
			ArrowUp: this.position - 40,
			ArrowDown: this.position + 40,
			PageUp: this.position - page,
			PageDown: this.position + page,
			Home: 0,
			End: this.maximum
		};
		if (!Object.hasOwn(positions, event.key)) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		this.move(positions[event.key]);
	};
	startDrag = (event: PointerEvent) => {
		if (event.button !== 0 || !event.isPrimary || !this.track || !this.viewport) {
			return;
		}
		this.measure();
		event.preventDefault();
		event.stopPropagation();
		this.track.focus({ preventScroll: true });
		if (event.target === this.track && this.travel) {
			const offset = event.clientY - this.track.getBoundingClientRect().top - this.thumbSize / 2;
			this.move((offset / this.travel) * this.maximum);
		}
		this.drag = { id: event.pointerId, y: event.clientY, position: this.viewport.scrollTop };
		this.dragging = true;
		this.track.setPointerCapture(event.pointerId);
	};
	moveDrag = (event: PointerEvent) => {
		if (!this.drag || this.drag.id !== event.pointerId || !this.travel) {
			return;
		}
		this.move(this.drag.position + ((event.clientY - this.drag.y) / this.travel) * this.maximum);
	};
	endDrag = (event?: PointerEvent) => {
		if (!this.drag || (event && event.pointerId !== this.drag.id)) {
			return;
		}
		const id = this.drag.id;
		this.drag = undefined;
		this.dragging = false;
		if (this.track?.hasPointerCapture(id)) {
			this.track.releasePointerCapture(id);
		}
	};
	mount(viewport: HTMLElement, content: HTMLElement, track: HTMLElement) {
		this.viewport = viewport;
		this.track = track;
		const observer = new ResizeObserver(this.measure);
		for (const element of [viewport, content, track]) {
			observer.observe(element);
		}
		viewport.addEventListener('scroll', this.scroll, { passive: true });
		track.addEventListener('wheel', this.wheel, { passive: false });
		this.measure();
		return () => {
			this.endDrag();
			clearTimeout(this.timer);
			observer.disconnect();
			viewport.removeEventListener('scroll', this.scroll);
			track.removeEventListener('wheel', this.wheel);
			this.viewport = undefined;
			this.track = undefined;
		};
	}
}
