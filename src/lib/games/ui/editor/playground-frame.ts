import type { EditorPlaythrough } from '../../editor-playground.js';
import type { EditorDiagnostic } from '../../editor-playground.js';
import type { Game } from '../../model.js';
import type { GameState } from '../../state/value.js';
import type { PanelInfo } from '../runtime/model.js';

import { mountGameUI, type GameUIHandle } from '../runtime/bridge.js';

export interface PlaygroundProps {
	game: Game;
	mode: 'preview' | 'test';
	ondiagnostic?: (entry: EditorDiagnostic) => void;
	onstate?: (state: GameState) => void;
}

export async function runPlaygroundAI(
	context: EditorPlaythrough,
	input: string,
	options: { signal: AbortSignal; ontext: (text: string, reset: boolean) => void }
) {
	await context.ai(
		input,
		{ visible: true },
		{
			signal: options.signal,
			onEvent: (event) => {
				if (event.type === 'text') {
					options.ontext(event.text, false);
				}
				if (event.type === 'reset') {
					options.ontext('', true);
				}
			}
		}
	);
}

export function attachPlaygroundFrame(
	frame: HTMLIFrameElement,
	context: EditorPlaythrough,
	callbacks: {
		blocked: () => boolean;
		onready: () => void;
		onbusy: (value: boolean) => void;
		onerror: (failure: unknown) => void;
		ondiagnostic: (message: string, detail: unknown) => void;
		onpanels: (count: number) => void;
	}
) {
	let canceled = false;
	let handle: GameUIHandle | undefined;
	let panels: PanelInfo[] = [];
	const resize = () => {
		const width = frame.getBoundingClientRect().width;
		if (width <= 0) {
			return;
		}
		handle?.setViews(
			panels.map((panel, index) => ({ id: panel.id, x: 0, y: index * 190, width, height: 185 }))
		);
	};
	const observer = new ResizeObserver(resize);
	observer.observe(frame);
	void mountGameUI(frame, context.game.id, context.game.activeSessionId, {
		runtime: context.runtime,
		ephemeral: true,
		blocked: callbacks.blocked,
		onready: () => {
			if (!canceled) {
				callbacks.onready();
			}
		},
		onbusy: (value) => {
			if (!canceled) {
				callbacks.onbusy(value);
			}
		},
		onerror: (message) => {
			if (!canceled) {
				callbacks.onerror(new Error(message));
			}
		},
		ondiagnostic: (message, detail) => {
			if (!canceled) {
				callbacks.ondiagnostic(message, detail);
			}
		},
		onpanels: (next) => {
			panels = next;
			if (canceled) {
				return;
			}
			callbacks.onpanels(panels.length);
			requestAnimationFrame(resize);
		}
	})
		.then((mounted) => {
			if (canceled) {
				mounted();
				return;
			}
			handle = mounted;
			resize();
		})
		.catch((failure: unknown) => {
			if (!canceled) {
				callbacks.onerror(failure);
			}
		});
	return () => {
		canceled = true;
		callbacks.onbusy(false);
		observer.disconnect();
		handle?.();
	};
}
