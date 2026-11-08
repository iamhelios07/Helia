import { tick } from 'svelte';

import type { AgentEvent } from '#lib/games/ai/protocol.js';
import type { SessionTimeline } from '#lib/games/state/history.js';

import { emptyAISettings, type AISettings } from '#lib/app/settings/model.js';
import { loadAISettings } from '#lib/app/settings/repository.js';
import {
	isSessionBusy,
	subscribeSessionActivity,
	subscribeSessionAIEvents
} from '#lib/games/ai/activity.js';
import { invokeSessionAI } from '#lib/games/ai/browser.js';

import type { Message, Session } from '../model.js';
import type { GameUI } from './runtime/model.js';

import {
	getSessionConversation,
	getSessionTimeline,
	selectSessionBranch,
	deleteSessionEvent,
	subscribeSessionChanges
} from '../repository.js';
import { safeChatStyle } from './chat-style.js';

interface SessionChatControllerOptions {
	uid: string;
	gameId: string;
	sessionId: string;
	gameTitle: string;
	draft: string;
	setDraft: (value: string) => void;
	onsessionupdate: (session: Session) => void;
	onsavingchange: (saving: boolean) => void;
	blocked?: boolean;
	chatStyle?: GameUI['chatStyle'];
}

export class SessionChatController {
	constructor(private readonly options: () => SessionChatControllerOptions) {
		$effect(() => {
			if (!this.blocked && !this.locked) {
				queueMicrotask(this.scheduleRefresh);
			}
		});
	}
	get gameId() {
		return this.options().gameId;
	}
	get sessionId() {
		return this.options().sessionId;
	}
	get gameTitle() {
		return this.options().gameTitle;
	}
	get draft() {
		return this.options().draft;
	}
	set draft(value: string) {
		this.options().setDraft(value);
	}
	get onsessionupdate() {
		return this.options().onsessionupdate;
	}
	get onsavingchange() {
		return this.options().onsavingchange;
	}
	get blocked() {
		return this.options().blocked ?? false;
	}
	get chatStyle() {
		return this.options().chatStyle;
	}
	messages = $state.raw<Message[]>([]);
	loading = $state(true);
	saving = $state(false);
	loadError = $state('');
	saveError = $state('');
	modelSettings = $state.raw<AISettings>(emptyAISettings());
	selectedModelId = $state('');
	modelError = $state('');
	externalBusy = $state(false);
	streamedText = $state('');
	thinking = $state('');
	progressText = $state('');
	toolProgress = $state<
		{
			id: number;
			name: string;
			status: 'running' | 'completed' | 'failed';
		}[]
	>([]);
	attemptStatus = $state<
		'idle' | 'generating' | 'committing' | 'committed' | 'failed' | 'cancelled' | 'incomplete'
	>('idle');
	externalAttempt = false;
	generation: AbortController | undefined;
	locked = $derived(this.saving || this.externalBusy);
	private readonly attemptLabels: Partial<Record<SessionChatController['attemptStatus'], string>> =
		{
			generating: '응답 생성 중…',
			committing: '응답 저장 중…',
			committed: '응답 저장 완료',
			cancelled: '생성 취소됨 · 저장되지 않은 응답',
			incomplete: '생성 중단 · 저장되지 않은 응답'
		};
	attemptLabel = $derived(
		this.attemptLabels[this.attemptStatus] ?? '생성 실패 · 저장되지 않은 응답'
	);
	showTimeline = $state(false);
	timeline = $state.raw<SessionTimeline | null>(null);
	timelineBusy = $state(false);
	timelineError = $state('');
	get uid() {
		return this.options().uid;
	}
	history: HTMLDivElement | undefined;
	composer: HTMLTextAreaElement | undefined;
	disposed = false;
	requestId = 0;
	refreshPending = false;
	refreshRunning = false;
	refreshTimer: ReturnType<typeof setTimeout> | undefined;
	theme = $derived(safeChatStyle(this.chatStyle));
	scheduleRefresh = () => {
		if (this.disposed || !this.refreshPending || this.refreshTimer !== undefined) {
			return;
		}
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			void this.refreshConversation();
		}, 0);
	};
	refreshConversation = async () => {
		if (
			this.disposed ||
			!this.refreshPending ||
			this.refreshRunning ||
			this.loading ||
			this.locked ||
			this.timelineBusy ||
			this.blocked
		) {
			return;
		}
		this.refreshPending = false;
		this.refreshRunning = true;
		const game = this.gameId;
		const session = this.sessionId;
		const request = ++this.requestId;
		try {
			const next = await getSessionTimeline(game, session);
			if (this.isCurrent(game, session) && request === this.requestId) {
				const previousTail = this.messages.at(-1);
				const nextTail = next.messages.at(-1);
				this.applyTimeline(
					next,
					previousTail?.id !== nextTail?.id || previousTail?.content !== nextTail?.content
				);
				this.loadError = '';
				this.timelineError = '';
			}
		} catch {
			if (this.isCurrent(game, session) && request === this.requestId) {
				this.timelineError = '이력을 불러오지 못했어요. 다시 시도해주세요.';
			}
		} finally {
			this.refreshRunning = false;
			this.scheduleRefresh();
		}
	};
	isCurrent = (game: string, session: string) => {
		return !this.disposed && this.gameId === game && this.sessionId === session;
	};
	applyTimeline = (next: SessionTimeline, scroll = true) => {
		this.timeline = next;
		this.messages = next.messages;
		this.onsessionupdate(next.session);
		if (scroll) {
			void this.scrollToEnd();
		}
	};
	reloadTimeline = async () => {
		if (this.timelineBusy || this.locked || this.loading) {
			return;
		}
		const game = this.gameId;
		const session = this.sessionId;
		const request = ++this.requestId;
		this.timelineBusy = true;
		this.timelineError = '';
		try {
			const next = await getSessionTimeline(game, session);
			if (this.isCurrent(game, session) && request === this.requestId) {
				this.applyTimeline(next);
			}
		} catch {
			if (this.isCurrent(game, session)) {
				this.timelineError = '이력을 불러오지 못했어요. 다시 시도해주세요.';
			}
		} finally {
			if (this.isCurrent(game, session) && request === this.requestId) {
				this.timelineBusy = false;
			}
			this.scheduleRefresh();
		}
	};
	changeTimeline = async (
		id: string | null,
		remove = false,
		expectedRevision?: number
	): Promise<boolean> => {
		if (!this.timeline || this.timelineBusy || this.locked || this.loading || this.blocked) {
			return false;
		}
		if (!remove && this.timeline.history.progress.headId === id) {
			return true;
		}
		const game = this.gameId;
		const session = this.sessionId;
		const revision = expectedRevision ?? this.timeline.history.progress.revision;
		this.requestId += 1;
		this.timelineBusy = true;
		this.timelineError = '';
		this.onsavingchange(true);
		try {
			let next: SessionTimeline;
			if (remove && id !== null) {
				next = await deleteSessionEvent(game, session, id, revision);
			} else {
				await selectSessionBranch(game, session, id, revision);
				next = await getSessionTimeline(game, session);
			}
			if (!this.isCurrent(game, session)) {
				return false;
			}
			this.applyTimeline(next);
			return true;
		} catch {
			if (this.isCurrent(game, session)) {
				this.timelineError = '이력을 변경하지 못했어요. 새로고침 후 다시 시도해주세요.';
			}
			return false;
		} finally {
			if (this.isCurrent(game, session)) {
				this.timelineBusy = false;
				this.onsavingchange(false);
				this.scheduleRefresh();
			}
		}
	};
	toggleTimeline = () => {
		this.showTimeline = !this.showTimeline;
		if (this.showTimeline) {
			void this.reloadTimeline();
		}
	};
	loadModels = () => {
		if (this.saving) {
			return;
		}
		try {
			this.modelSettings = loadAISettings();
			if (!this.modelSettings.models.some((model) => model.id === this.selectedModelId)) {
				this.selectedModelId =
					this.modelSettings.defaultModelId ?? this.modelSettings.models[0]?.id ?? '';
			}
			this.modelError = '';
		} catch (error) {
			this.modelError = error instanceof Error ? error.message : '모델 설정을 불러오지 못했어요.';
		}
	};
	receiveAgentEvent = (event: AgentEvent) => {
		if (event.type === 'error') {
			this.saveError = event.message;
			this.attemptStatus = 'incomplete';
			this.finishInterruptedTools();
		} else if (event.type === 'reset') {
			this.streamedText = '';
		} else if (event.type === 'text') {
			this.streamedText += event.text;
		} else if (event.type === 'thinking') {
			this.thinking += event.text;
		} else if (event.type === 'progress') {
			this.progressText += `${this.progressText ? '\n\n' : ''}${event.text}`;
		} else if (event.type === 'tool') {
			const running = this.toolProgress.findLast(
				(tool) => tool.name === event.name && tool.status === 'running'
			);
			if (event.status === 'running' || !running) {
				this.toolProgress.push({
					id: this.toolProgress.length,
					name: event.name,
					status: event.status
				});
			} else {
				running.status = event.status;
			}
		} else {
			this.attemptStatus = event.status;
		}
		void this.scrollToEnd();
	};
	resetAttempt = () => {
		this.saveError = '';
		this.streamedText = '';
		this.thinking = '';
		this.progressText = '';
		this.toolProgress = [];
		this.attemptStatus = 'generating';
	};
	finishInterruptedTools = () => {
		for (const tool of this.toolProgress) {
			if (tool.status === 'running') {
				tool.status = 'failed';
			}
		}
	};
	stopGeneration = () => {
		this.generation?.abort();
	};
	attachHistory = (element: HTMLDivElement) => {
		this.history = element;
		return () => {
			this.history = undefined;
		};
	};
	attachComposer = (element: HTMLTextAreaElement) => {
		this.composer = element;
		return () => {
			this.composer = undefined;
		};
	};
	scrollToEnd = async () => {
		await tick();
		if (!this.disposed && this.history) {
			this.history.scrollTop = this.history.scrollHeight;
		}
	};
	loadConversation = async () => {
		const game = this.gameId;
		const session = this.sessionId;
		this.loading = true;
		this.loadError = '';
		try {
			const conversation = await getSessionConversation(game, session);
			if (!this.isCurrent(game, session)) {
				return;
			}
			this.messages = conversation.messages;
			this.onsessionupdate(conversation.session);
			void this.scrollToEnd();
		} catch {
			if (this.isCurrent(game, session)) {
				this.loadError = '채팅 기록을 불러오지 못했어요.';
			}
		} finally {
			if (this.isCurrent(game, session)) {
				this.loading = false;
			}
			this.scheduleRefresh();
		}
	};
	generationError = (controller: AbortController, error: unknown) => {
		if (controller.signal.aborted) {
			return '생성을 취소했어요. 입력 내용은 유지돼요.';
		}
		return error instanceof Error ? error.message : '응답을 생성하지 못했어요. 다시 시도해주세요.';
	};
	finishGeneration = (controller: AbortController, game: string, session: string) => {
		if (this.generation === controller) {
			this.generation = undefined;
		}
		if (!this.isCurrent(game, session)) {
			return;
		}
		this.saving = false;
		this.onsavingchange(false);
		this.scheduleRefresh();
	};
	sendMessage = async (event?: SubmitEvent) => {
		event?.preventDefault();
		if (
			this.loading ||
			this.locked ||
			this.timelineBusy ||
			this.blocked ||
			this.loadError ||
			!this.draft.trim()
		) {
			return;
		}
		this.loadModels();
		if (this.modelError || !this.selectedModelId) {
			return;
		}
		this.requestId += 1;
		const game = this.gameId;
		const session = this.sessionId;
		this.saving = true;
		this.resetAttempt();
		const controller = new AbortController();
		this.generation = controller;
		this.onsavingchange(true);
		const content = this.draft;
		try {
			const saved = await invokeSessionAI(
				game,
				session,
				{ text: content, modelId: this.selectedModelId },
				{
					signal: controller.signal,
					onEvent: (event) => {
						if (this.isCurrent(game, session)) {
							this.receiveAgentEvent(event);
						}
					}
				}
			);
			if (!this.isCurrent(game, session)) {
				return;
			}
			this.applyTimeline(saved);
			this.attemptStatus = 'committed';
			this.draft = '';
			void this.scrollToEnd();
			this.composer?.focus();
		} catch (error) {
			if (this.isCurrent(game, session)) {
				this.attemptStatus = controller.signal.aborted ? 'cancelled' : 'failed';
				this.finishInterruptedTools();
				this.saveError = this.generationError(controller, error);
			}
		} finally {
			this.finishGeneration(controller, game, session);
		}
		if (this.isCurrent(game, session) && this.showTimeline) {
			void this.reloadTimeline();
		}
	};
	handleKeydown = (event: KeyboardEvent) => {
		if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) {
			return;
		}
		event.preventDefault();
		void this.sendMessage();
	};
	mount = () => {
		this.loadModels();
		this.externalBusy = isSessionBusy(this.gameId, this.sessionId);
		const unsubscribeActivity = subscribeSessionActivity(this.gameId, this.sessionId, () => {
			this.externalBusy = isSessionBusy(this.gameId, this.sessionId);
			if (!this.externalBusy && this.externalAttempt) {
				if (this.attemptStatus !== 'committed') {
					this.attemptStatus = 'incomplete';
					this.finishInterruptedTools();
				}
				this.externalAttempt = false;
			}
		});
		const unsubscribeAIEvents = subscribeSessionAIEvents(this.gameId, this.sessionId, (event) => {
			if (this.saving) {
				return;
			}
			if (event.type === 'status' && event.status === 'generating') {
				this.externalAttempt = true;
				this.resetAttempt();
			}
			this.receiveAgentEvent(event);
		});
		const unsubscribe = subscribeSessionChanges(this.gameId, this.sessionId, () => {
			this.refreshPending = true;
			this.scheduleRefresh();
		});
		void this.loadConversation();
		return () => {
			this.disposed = true;
			this.generation?.abort();
			unsubscribeActivity();
			unsubscribeAIEvents();
			unsubscribe();
			if (this.refreshTimer !== undefined) {
				clearTimeout(this.refreshTimer);
			}
		};
	};
}
