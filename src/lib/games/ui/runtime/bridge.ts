import { invokeSessionAI } from '#lib/games/ai/browser.js';
import {
	getSessionHistory,
	executeSessionAction,
	commitSessionTransaction,
	subscribeSessionChanges,
	subscribeSessionEvents
} from '#lib/games/repository.js';
import { parseAction, type SessionHistory } from '#lib/games/state/model.js';
import { parseGameState, type GameState } from '#lib/games/state/value.js';

import { compileGameUI } from './compiler.js';
import { UI_LIMITS, type GameUI, type PanelInfo, type PanelView } from './model.js';

// UI State lasts only for this application execution, scoped to a game and session.
const transient = new Map<string, GameState>();
export type GameUIHandle = (() => void) & { setViews(views: PanelView[]): void };
export interface GameUIRuntime {
	getSessionHistory: typeof getSessionHistory;
	executeSessionAction: typeof executeSessionAction;
	commitSessionTransaction: typeof commitSessionTransaction;
	subscribeSessionChanges: typeof subscribeSessionChanges;
	subscribeSessionEvents: typeof subscribeSessionEvents;
	invokeSessionAI: typeof invokeSessionAI;
}
function defaultRuntime(): GameUIRuntime {
	return {
		getSessionHistory,
		executeSessionAction,
		commitSessionTransaction,
		subscribeSessionChanges,
		subscribeSessionEvents,
		invokeSessionAI
	};
}
export interface MountOptions {
	onerror?: (message: string) => void;
	onready?: () => void;
	onui?: (ui: GameUI | undefined) => void;
	onbusy?: (busy: boolean) => void;
	onpanels?: (panels: PanelInfo[]) => void;
	/** The current iframe must be remounted when an applied authoring snapshot changes. */
	oncontentchange?: () => void;
	blocked?: () => boolean;
	/** An isolated authoring runtime; omitted during normal play. */
	runtime?: GameUIRuntime;
	ondiagnostic?: (message: string, detail?: unknown) => void;
	/** Isolated previews must not retain transient UI state after disposal. */
	ephemeral?: boolean;
}

interface BridgeContext {
	frame: HTMLIFrameElement;
	gameId: string;
	sessionId: string;
	runtime: GameUIRuntime;
	options: MountOptions;
}

/** The iframe has no origin/storage/native privileges; the host owns validation and all commits. */
export async function mountGameUI(
	frame: HTMLIFrameElement,
	gameId: string,
	sessionId: string,
	options: MountOptions = {}
): Promise<GameUIHandle> {
	const runtime = options.runtime ?? defaultRuntime();
	const history = await runtime.getSessionHistory(gameId, sessionId);
	const ui = history.snapshot.ui;
	options.onui?.(ui);
	const context = { frame, gameId, sessionId, options, runtime };
	if (!ui) {
		return watchContent(context, history);
	}
	const token = crypto.randomUUID();
	const document = await compileGameUI(ui, token, history.resources);
	return new GameUIBridge(context, history, token).mount(document);
}

function watchContent(context: BridgeContext, history: SessionHistory): GameUIHandle {
	const { options, runtime, gameId, sessionId } = context;
	options.onready?.();
	let disposed = false;
	const unsubscribe = options.oncontentchange
		? runtime.subscribeSessionChanges(gameId, sessionId, () => {
				void runtime
					.getSessionHistory(gameId, sessionId)
					.then((next) => {
						if (!disposed && next.snapshot.id !== history.snapshot.id) {
							cleanup();
							options.oncontentchange?.();
						}
					})
					.catch(() => {
						if (!disposed) {
							options.onerror?.('게임 상태를 새로 불러오지 못했어요.');
						}
					});
			})
		: () => {};
	function cleanup() {
		if (disposed) {
			return;
		}
		disposed = true;
		unsubscribe();
	}
	return Object.assign(cleanup, { setViews: () => {} });
}

class GameUIBridge {
	private readonly channel = new MessageChannel();
	private readonly abort = new AbortController();
	private disposed = false;
	private connected = false;
	private busy = false;
	private refreshing: Promise<void> | undefined;
	private dirty = false;
	private readonly queuedEvents: GameState[] = [];
	private unsubscribeChanges: () => void = () => {};
	private unsubscribeEvents: () => void = () => {};
	private timeout: ReturnType<typeof setTimeout> | undefined;
	private loads = 0;
	private readonly stateKey: string;

	constructor(
		private readonly context: BridgeContext,
		private history: SessionHistory,
		private readonly token: string
	) {
		this.stateKey = JSON.stringify([context.gameId, context.sessionId]);
	}
	private get options() {
		return this.context.options;
	}
	private send(message: unknown) {
		if (!this.disposed && this.connected) {
			this.channel.port1.postMessage(JSON.stringify(message));
		}
	}
	private sendState() {
		this.send({
			kind: 'state',
			state: this.history.progress.state,
			revision: this.history.progress.revision
		});
	}
	private drainEvents() {
		for (const event of this.queuedEvents.splice(0)) {
			this.send({ kind: 'event', event });
		}
	}
	private async refreshState() {
		const { runtime, gameId, sessionId } = this.context;
		while (this.dirty && !this.disposed) {
			this.dirty = false;
			const next = await runtime.getSessionHistory(gameId, sessionId);
			if (!this.disposed && next.snapshot.id !== this.history.snapshot.id) {
				this.dispose();
				this.options.oncontentchange?.();
				return;
			}
			if (!this.disposed && next.progress.revision >= this.history.progress.revision) {
				this.history = next;
				this.sendState();
			}
		}
		this.drainEvents();
	}
	private refresh(): Promise<void> {
		this.dirty = true;
		this.refreshing ??= this.refreshState()
			.catch(() => {
				if (!this.disposed) {
					this.options.onerror?.('게임 상태를 새로 불러오지 못했어요.');
				}
			})
			.finally(() => {
				this.refreshing = undefined;
			});
		return this.refreshing;
	}
	private receiveNotice(message: GameState): boolean {
		switch (message.kind) {
			case 'ready':
				clearTimeout(this.timeout);
				this.options.onready?.();
				return true;
			case 'error':
				this.options.ondiagnostic?.('게임 UI 실행 오류', message);
				clearTimeout(this.timeout);
				this.options.onerror?.('게임 UI를 실행하지 못했어요. 다시 시도해주세요.');
				this.dispose();
				return true;
			case 'diagnostic':
				this.options.ondiagnostic?.('게임 UI 패널 오류', message);
				return true;
			case 'panels': {
				const panels = parsePanels(message.panels);
				this.options.onpanels?.(panels);
				return true;
			}
			case 'ui-state': {
				const values = parseGameState(message.values);
				if (JSON.stringify(values).length > 256 * 1024 || Object.keys(values).length > 1024) {
					throw Error('UI State limit');
				}
				transient.set(this.stateKey, values);
				return true;
			}
			default:
				return false;
		}
	}
	private async execute(message: GameState): Promise<SessionHistory> {
		const { runtime, gameId, sessionId } = this.context;
		const options = { signal: this.abort.signal };
		if (message.kind === 'ai') {
			if (typeof message.text !== 'string') {
				throw Error('Invalid AI request');
			}
			return (
				await runtime.invokeSessionAI(
					gameId,
					sessionId,
					{ text: message.text, visible: message.visible === true },
					options
				)
			).history;
		}
		const action = parseAction(message.action);
		const expectedRevision = this.history.progress.revision;
		if (message.kind === 'action') {
			return runtime.executeSessionAction(gameId, sessionId, { expectedRevision, action }, options);
		}
		return runtime.commitSessionTransaction(
			gameId,
			sessionId,
			{
				expectedRevision,
				parentId: this.history.progress.headId,
				action,
				nextState: parseGameState(message.state)
			},
			options
		);
	}
	private async applyRequest(message: GameState) {
		if (this.busy || this.options.blocked?.()) {
			throw Error('Busy');
		}
		// Validate action input before exposing a busy transition to the host.
		if (message.kind !== 'ai') {
			parseAction(message.action);
		}
		this.busy = true;
		this.options.onbusy?.(true);
		try {
			const result = await this.execute(message);
			if (this.disposed) {
				return;
			}
			if (result.progress.revision >= this.history.progress.revision) {
				this.history = result;
			}
			this.sendState();
			await this.refresh();
		} finally {
			this.busy = false;
			if (!this.disposed) {
				this.options.onbusy?.(false);
			}
		}
		this.send({
			kind: 'response',
			id: message.id,
			ok: true,
			result: { revision: this.history.progress.revision }
		});
	}
	private async receive(event: MessageEvent<unknown>) {
		let id: string | undefined;
		try {
			if (
				this.disposed ||
				typeof event.data !== 'string' ||
				new TextEncoder().encode(event.data).length > UI_LIMITS.wireBytes
			) {
				return;
			}
			const message = parseGameState(JSON.parse(event.data));
			if (this.receiveNotice(message)) {
				return;
			}
			if (
				!['action', 'transaction', 'ai'].includes(String(message.kind)) ||
				typeof message.id !== 'string' ||
				!/^\d{1,12}$/.test(message.id)
			) {
				return;
			}
			id = message.id;
			await this.applyRequest(message);
		} catch (error) {
			this.options.ondiagnostic?.('게임 UI 요청 실패', error);
			if (id) {
				this.send({
					kind: 'response',
					id,
					ok: false,
					error: '변경을 적용하지 못했어요. 상태와 입력을 확인하고 다시 시도해주세요.'
				});
			}
		}
	}
	private initialize = (event: MessageEvent) => {
		const frame = this.context.frame;
		if (
			this.disposed ||
			this.connected ||
			event.source !== frame.contentWindow ||
			event.data?.heliaUI !== this.token
		) {
			return;
		}
		this.connected = true;
		window.removeEventListener('message', this.initialize);
		frame.contentWindow!.postMessage({ token: this.token }, '*', [this.channel.port2]);
		this.send({
			kind: 'init',
			state: this.history.progress.state,
			uiState: transient.get(this.stateKey) ?? {}
		});
	};
	private navigation = () => {
		if (++this.loads <= 1) {
			return;
		}
		this.options.onerror?.('게임 UI의 페이지 이동은 지원하지 않아요.');
		this.dispose();
	};
	private dispose = () => {
		if (this.disposed) {
			return;
		}
		this.send({ kind: 'dispose' });
		this.disposed = true;
		this.abort.abort();
		clearTimeout(this.timeout);
		this.unsubscribeChanges();
		this.unsubscribeEvents();
		window.removeEventListener('message', this.initialize);
		this.context.frame.removeEventListener('load', this.navigation);
		this.channel.port1.close();
		this.channel.port2.close();
		if (this.options.ephemeral) {
			transient.delete(this.stateKey);
		}
		this.context.frame.removeAttribute('srcdoc');
		if (this.busy) {
			this.options.onbusy?.(false);
		}
	};
	mount(document: string): GameUIHandle {
		const { runtime, gameId, sessionId, frame } = this.context;
		this.unsubscribeChanges = runtime.subscribeSessionChanges(gameId, sessionId, () => {
			void this.refresh();
		});
		this.unsubscribeEvents = runtime.subscribeSessionEvents(gameId, sessionId, (event) => {
			if (this.queuedEvents.length < 128) {
				this.queuedEvents.push(parseGameState(event));
			}
			void this.refresh();
		});
		this.channel.port1.onmessage = (event) => {
			void this.receive(event);
		};
		this.channel.port1.start();
		window.addEventListener('message', this.initialize);
		frame.addEventListener('load', this.navigation);
		this.timeout = setTimeout(() => {
			this.options.onerror?.('게임 UI가 응답하지 않아요. 다시 시도해주세요.');
			this.dispose();
		}, 15_000);
		frame.setAttribute('sandbox', 'allow-scripts');
		frame.referrerPolicy = 'no-referrer';
		frame.srcdoc = document;
		return Object.assign(this.dispose, {
			setViews: (views: PanelView[]) => {
				validateViews(views);
				this.send({ kind: 'views', views });
			}
		});
	}
}

function parsePanels(value: unknown): PanelInfo[] {
	if (!Array.isArray(value) || value.length > UI_LIMITS.panels) {
		throw Error('Invalid panels');
	}
	const panels = value.map((item) => {
		const panel = parseGameState(item);
		if (
			typeof panel.id !== 'string' ||
			!/^[\w-]{1,80}$/.test(panel.id) ||
			typeof panel.title !== 'string' ||
			!panel.title.trim() ||
			panel.title.length > 100
		) {
			throw Error('Invalid panel');
		}
		return { id: panel.id, title: panel.title };
	});
	if (new Set(panels.map((panel) => panel.id)).size !== panels.length) {
		throw Error('Duplicate panels');
	}
	return panels;
}
function validateViews(views: PanelView[]): void {
	if (
		views.length > UI_LIMITS.panels ||
		views.some(
			(view) =>
				typeof view.id !== 'string' ||
				!/^[\w-]{1,80}$/.test(view.id) ||
				[view.x, view.y, view.width, view.height].some(
					(n) => !Number.isFinite(n) || n < 0 || n > 100_000
				)
		)
	) {
		throw Error('Invalid panel geometry');
	}
}
