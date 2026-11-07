import {
	getSessionHistory,
	executeSessionAction,
	commitSessionTransaction,
	subscribeSessionChanges,
	subscribeSessionEvents
} from '#lib/games/repository.js';
import { parseAction, type SessionHistory } from '#lib/games/state/model.js';
import { parseGameState, type GameState } from '#lib/games/state/value.js';
import { UI_LIMITS, type GameUI, type PanelInfo, type PanelView } from './model.js';
import { compileGameUI } from './compiler.js';
import { invokeSessionAI } from '#lib/games/ai/browser.js';

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

/** The iframe has no origin/storage/native privileges; the host owns validation and all commits. */
export async function mountGameUI(
	frame: HTMLIFrameElement,
	gameId: string,
	sessionId: string,
	options: MountOptions = {}
): Promise<GameUIHandle> {
	const runtime = options.runtime ?? defaultRuntime();
	let history = await runtime.getSessionHistory(gameId, sessionId);
	const ui = history.snapshot.ui;
	options.onui?.(ui);
	if (!ui) {
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
							if (!disposed) options.onerror?.('게임 상태를 새로 불러오지 못했어요.');
						});
				})
			: () => {};
		function cleanup() {
			if (disposed) return;
			disposed = true;
			unsubscribe();
		}
		return Object.assign(cleanup, { setViews: () => {} });
	}
	const token = crypto.randomUUID();
	const document = await compileGameUI(ui, token, history.snapshot.resources);
	const channel = new MessageChannel();
	const abort = new AbortController();
	const stateKey = JSON.stringify([gameId, sessionId]);
	let disposed = false,
		connected = false,
		busy = false,
		refreshing: Promise<void> | undefined,
		dirty = false;
	const queuedEvents: GameState[] = [];
	const send = (message: unknown) => {
		if (!disposed && connected) channel.port1.postMessage(JSON.stringify(message));
	};
	const sendState = () =>
		send({ kind: 'state', state: history.progress.state, revision: history.progress.revision });
	function drainEvents() {
		for (const event of queuedEvents.splice(0)) send({ kind: 'event', event });
	}
	function refresh(): Promise<void> {
		dirty = true;
		if (!refreshing)
			refreshing = (async () => {
				try {
					while (dirty && !disposed) {
						dirty = false;
						const next = await runtime.getSessionHistory(gameId, sessionId);
						if (!disposed && next.snapshot.id !== history.snapshot.id) {
							dispose();
							options.oncontentchange?.();
							return;
						}
						if (!disposed && next.progress.revision >= history.progress.revision) {
							history = next;
							sendState();
						}
					}
					drainEvents();
				} catch {
					if (!disposed) options.onerror?.('게임 상태를 새로 불러오지 못했어요.');
				} finally {
					refreshing = undefined;
				}
			})();
		return refreshing;
	}
	const unsubscribeChanges = runtime.subscribeSessionChanges(gameId, sessionId, () => {
		void refresh();
	});
	const unsubscribeEvents = runtime.subscribeSessionEvents(gameId, sessionId, (event) => {
		if (queuedEvents.length < 128) queuedEvents.push(parseGameState(event));
		void refresh();
	});
	const receive = async (event: MessageEvent<unknown>) => {
		let id: string | undefined;
		try {
			if (
				disposed ||
				typeof event.data !== 'string' ||
				new TextEncoder().encode(event.data).length > UI_LIMITS.wireBytes
			)
				return;
			const message = parseGameState(JSON.parse(event.data));
			if (message.kind === 'ready') {
				clearTimeout(timeout);
				options.onready?.();
				return;
			}
			if (message.kind === 'error') {
				options.ondiagnostic?.('게임 UI 실행 오류', message);
				clearTimeout(timeout);
				options.onerror?.('게임 UI를 실행하지 못했어요. 다시 시도해주세요.');
				dispose();
				return;
			}
			if (message.kind === 'diagnostic') {
				options.ondiagnostic?.('게임 UI 패널 오류', message);
				return;
			}
			if (message.kind === 'panels') {
				if (!Array.isArray(message.panels) || message.panels.length > UI_LIMITS.panels)
					throw Error('Invalid panels');
				const panels = message.panels.map((item) => {
					const panel = parseGameState(item);
					if (
						typeof panel.id !== 'string' ||
						!/^[\w-]{1,80}$/.test(panel.id) ||
						typeof panel.title !== 'string' ||
						!panel.title.trim() ||
						panel.title.length > 100
					)
						throw Error('Invalid panel');
					return { id: panel.id, title: panel.title };
				});
				if (new Set(panels.map((panel) => panel.id)).size !== panels.length)
					throw Error('Duplicate panels');
				options.onpanels?.(panels);
				return;
			}
			if (message.kind === 'ui-state') {
				const values = parseGameState(message.values);
				if (JSON.stringify(values).length > 256 * 1024 || Object.keys(values).length > 1024)
					throw Error('UI State limit');
				transient.set(stateKey, values);
				return;
			}
			if (
				!['action', 'transaction', 'ai'].includes(String(message.kind)) ||
				typeof message.id !== 'string' ||
				!/^\d{1,12}$/.test(message.id)
			)
				return;
			id = message.id;
			if (busy || options.blocked?.()) throw Error('Busy');
			const action = message.kind === 'ai' ? undefined : parseAction(message.action);
			busy = true;
			options.onbusy?.(true);
			let result: SessionHistory;
			try {
				if (message.kind === 'ai') {
					if (typeof message.text !== 'string') throw Error('Invalid AI request');
					result = (
						await runtime.invokeSessionAI(
							gameId,
							sessionId,
							{ text: message.text, visible: message.visible === true },
							{ signal: abort.signal }
						)
					).history;
				} else if (message.kind === 'action')
					result = await runtime.executeSessionAction(
						gameId,
						sessionId,
						{ expectedRevision: history.progress.revision, action: action! },
						{ signal: abort.signal }
					);
				else
					result = await runtime.commitSessionTransaction(
						gameId,
						sessionId,
						{
							expectedRevision: history.progress.revision,
							parentId: history.progress.headId,
							action: action!,
							nextState: parseGameState(message.state)
						},
						{ signal: abort.signal }
					);
				if (disposed) return;
				if (result.progress.revision >= history.progress.revision) history = result;
				sendState();
				await refresh();
			} finally {
				busy = false;
				if (!disposed) options.onbusy?.(false);
			}
			send({ kind: 'response', id, ok: true, result: { revision: history.progress.revision } });
		} catch (error) {
			options.ondiagnostic?.('게임 UI 요청 실패', error);
			if (id)
				send({
					kind: 'response',
					id,
					ok: false,
					error: '변경을 적용하지 못했어요. 상태와 입력을 확인하고 다시 시도해주세요.'
				});
		}
	};
	channel.port1.onmessage = (event) => {
		void receive(event);
	};
	channel.port1.start();
	function initialize(event: MessageEvent) {
		if (
			disposed ||
			connected ||
			event.source !== frame.contentWindow ||
			event.data?.heliaUI !== token
		)
			return;
		connected = true;
		window.removeEventListener('message', initialize);
		frame.contentWindow!.postMessage({ token }, '*', [channel.port2]);
		send({
			kind: 'init',
			state: history.progress.state,
			uiState: transient.get(stateKey) ?? {}
		});
	}
	function dispose() {
		if (disposed) return;
		send({ kind: 'dispose' });
		disposed = true;
		abort.abort();
		clearTimeout(timeout);
		unsubscribeChanges();
		unsubscribeEvents();
		window.removeEventListener('message', initialize);
		frame.removeEventListener('load', navigation);
		channel.port1.close();
		channel.port2.close();
		if (options.ephemeral) transient.delete(stateKey);
		frame.removeAttribute('srcdoc');
		if (busy) options.onbusy?.(false);
	}
	let loads = 0;
	function navigation() {
		if (++loads > 1) {
			options.onerror?.('게임 UI의 페이지 이동은 지원하지 않아요.');
			dispose();
		}
	}
	window.addEventListener('message', initialize);
	frame.addEventListener('load', navigation);
	const timeout = setTimeout(() => {
		options.onerror?.('게임 UI가 응답하지 않아요. 다시 시도해주세요.');
		dispose();
	}, 15_000);
	frame.setAttribute('sandbox', 'allow-scripts');
	frame.referrerPolicy = 'no-referrer';
	frame.srcdoc = document;
	return Object.assign(dispose, {
		setViews(views: PanelView[]) {
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
			)
				throw Error('Invalid panel geometry');
			send({ kind: 'views', views });
		}
	});
}
