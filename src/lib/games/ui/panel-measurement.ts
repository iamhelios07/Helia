import type { PanelLayout, PanelView } from './runtime/model.js';

import { measurePanelViews } from './panel-geometry.js';
import { panelIds } from './runtime/layout.js';

/** Observe only mounted panel bodies and coalesce geometry reads into one animation frame. */
export class PanelMeasurement {
	area: HTMLDivElement | undefined;
	readonly bodies: Record<string, HTMLDivElement> = Object.create(null);
	expectedIds: string[] = [];
	private observer: ResizeObserver | undefined;
	private animation: number | undefined;

	constructor(private readonly onmeasure: (views: PanelView[], chat?: PanelView) => void) {}

	scheduleMeasure = (layout?: PanelLayout) => {
		if (layout) {
			this.expectedIds = panelIds(layout);
		}
		if (!this.area || this.animation !== undefined) {
			return;
		}
		this.animation = requestAnimationFrame(() => {
			this.animation = undefined;
			if (!this.area) {
				return;
			}
			const measured = measurePanelViews(
				this.area.getBoundingClientRect(),
				this.bodies,
				this.expectedIds
			);
			this.onmeasure(measured.views, measured.chat);
		});
	};

	attachArea(element: HTMLDivElement, ondispose: () => void): () => void {
		this.area = element;
		this.observer = new ResizeObserver(() => this.scheduleMeasure());
		this.observer.observe(element);
		for (const body of Object.values(this.bodies)) {
			this.observer.observe(body);
		}
		this.scheduleMeasure();
		return () => {
			ondispose();
			this.observer?.disconnect();
			this.observer = undefined;
			if (this.animation !== undefined) {
				cancelAnimationFrame(this.animation);
			}
			this.animation = undefined;
			this.area = undefined;
		};
	}

	attachBody = (id: string, element: HTMLDivElement): (() => void) => {
		this.bodies[id] = element;
		this.observer?.observe(element);
		this.scheduleMeasure();
		return () => {
			this.observer?.unobserve(element);
			if (this.bodies[id] === element) {
				delete this.bodies[id];
			}
			this.scheduleMeasure();
		};
	};
}
