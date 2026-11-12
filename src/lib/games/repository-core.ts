import type { TransactionValidator } from '#lib/games/state/workspace.js';

import { createSessionEvents } from '#lib/games/scripting/events.js';
import { executeSessionWork, type ExecutionReport } from '#lib/games/scripting/execution.js';
import {
	CreatorRuntimeError,
	type ActionRunner,
	type RunOptions,
	type ActionRequest
} from '#lib/games/scripting/protocol.js';
import {
	activeMemories,
	activeTransactions,
	assertRevision,
	checkoutHistory,
	createSessionState,
	prepareTransaction,
	stateAt,
	type CommitTransaction
} from '#lib/games/state/engine.js';
import { historyEvents, type SessionTimeline } from '#lib/games/state/history.js';
import {
	contentHash,
	counter,
	identifier,
	parseAction,
	parseGameSnapshot,
	parseMemory,
	parseSnapshotCheckpoint,
	parseSnapshotResource,
	parseSessionState,
	parseTransaction,
	type SessionHistory
} from '#lib/games/state/model.js';
import { emptyStateDocument, parseStateDocument } from '#lib/games/state/schema.js';
import { parseGameState, sameValue } from '#lib/games/state/value.js';
import { storedRecord, type StorageTransport } from '#lib/storage/protocol.js';
import { useStorage, type StorageUnit } from '#lib/storage/unit.js';

import type { AgentWorkspaceResult } from './ai/loop.js';
import type { GameResources } from './resources.js';
import type { RuleTrigger } from './scripting/protocol.js';

import { isSessionBusy } from './ai/activity.js';
import { parseGameAIContent } from './ai/prompts.js';
import { aiError } from './ai/protocol.js';
import { compileCodeProject } from './code-project.js';
import { editorContent, type GameEditorContent } from './editor.js';
import {
	parseGame,
	parseSession,
	parseMessage,
	parseScripts,
	validateGameMetadata,
	validateGameSettings,
	validateSessionTitle,
	validateMessageContent,
	type Game,
	type Session,
	type Message,
	type GameMetadata,
	type UpdateGameSettings
} from './model.js';
import { migrateState } from './state/migration.js';
import { parseGameUI } from './ui/runtime/model.js';
function makeSession(gameId: string): Session {
	const now = new Date().toISOString();
	return {
		schemaVersion: 1,
		id: crypto.randomUUID(),
		gameId,
		title: '새 세션',
		createdAt: now,
		updatedAt: now,
		messageCount: 0
	};
}
function makeMessage(
	session: Session,
	sequence: number,
	{ role, content, kind }: Pick<Message, 'role' | 'content' | 'kind'>
): Message {
	return parseMessage({
		schemaVersion: 1,
		id: crypto.randomUUID(),
		gameId: session.gameId,
		sessionId: session.id,
		sequence,
		role,
		content,
		kind,
		createdAt: new Date().toISOString()
	});
}
function gameIn(unit: StorageUnit, id: string): Game {
	const value = unit.get('games', id);
	if (value === undefined) {
		throw new Error('게임을 찾을 수 없어요.');
	}
	return parseGame(value);
}
function owner(unit: StorageUnit, gameId: string, sessionId: string) {
	const game = gameIn(unit, gameId);
	const value = unit.get('sessions', sessionId);
	if (value === undefined) {
		throw new Error('세션을 찾을 수 없어요.');
	}
	const session = parseSession(value);
	if (session.gameId !== gameId) {
		throw new Error('이 게임에 속한 세션이 아니에요.');
	}
	return { game, session };
}
function messagesIn(unit: StorageUnit, session: Session): Message[] {
	const messages = unit
		.all('messages')
		.map(parseMessage)
		.sort((a, b) => a.sequence - b.sequence);
	if (
		messages.length !== (session.messageCount ?? 0) ||
		messages.some(
			(message, index) =>
				message.sessionId !== session.id ||
				message.gameId !== session.gameId ||
				message.sequence !== index + 1
		)
	) {
		throw new Error('저장된 채팅 기록을 확인할 수 없어요.');
	}
	return messages;
}

/**
 * Returns the shared snapshot for this content, creating the row and its blob
 * references on first use. The id is the content fingerprint, so sessions that
 * play identical authored content share one row instead of copying it.
 */
function contentSnapshot(unit: StorageUnit, gameId: string, game: Game) {
	const content = {
		settings: game.settings,
		initialState: game.initialState,
		schema: game.schema,
		scripts: game.scripts,
		...(game.ui ? { ui: game.ui } : {}),
		...(game.ai ? { ai: game.ai } : {}),
		...(game.code ? { code: game.code } : {})
	};
	const id = contentHash(content);
	const existing = unit.get('snapshots', id);
	if (existing !== undefined) {
		return parseGameSnapshot(existing);
	}
	const snapshot = parseGameSnapshot({
		schemaVersion: 1,
		id,
		gameId,
		createdAt: new Date().toISOString(),
		...content
	});
	unit.put('snapshots', snapshot);
	for (const [assetId, asset] of Object.entries(game.resources ?? {})) {
		const name = asset.name;
		const fingerprint = contentHash(asset.data);
		if (unit.get('blobs', fingerprint) === undefined) {
			// The blob row is game-owned; snapshots reference it through snapshot_resources.
			unit.put('blobs', {
				schemaVersion: 1,
				id: fingerprint,
				gameId,
				mime: asset.mime,
				data: asset.data
			});
		}
		// The per-path name row keeps creator asset paths; the blob id deduplicates bytes.
		unit.put('snapshot_resources', {
			schemaVersion: 1,
			id: contentHash(assetId + fingerprint),
			snapshotId: id,
			gameId,
			blobId: fingerprint,
			assetId,
			name
		});
	}
	return snapshot;
}
/** The resources a snapshot exposes, resolved back to portable data URIs. */
function snapshotResources(unit: StorageUnit, snapshotId: string): GameResources {
	const result: GameResources = {};
	for (const reference of unit
		.all('snapshot_resources')
		.map(parseSnapshotResource)
		.filter((row) => row.snapshotId === snapshotId)) {
		const blob = unit.get('blobs', reference.blobId) as { mime: string; data: string } | undefined;
		if (!blob) {
			throw new Error('리소스 데이터를 찾을 수 없어요.');
		}
		result[reference.assetId] = { name: reference.name, mime: blob.mime, data: blob.data };
	}
	return result;
}
function initialize(unit: StorageUnit, gameId: string, sessionId: string) {
	const { game, session: previous } = owner(unit, gameId, sessionId);
	let session = previous;
	let messages = messagesIn(unit, session);
	if (game.settings.firstMessage.trim() && messages[0]?.kind !== 'opening') {
		for (const message of messages) {
			unit.put('messages', { ...message, sequence: counter(message.sequence + 1) });
		}
		unit.put(
			'messages',
			makeMessage(session, 1, {
				role: 'assistant',
				content: game.settings.firstMessage,
				kind: 'opening'
			})
		);
		session = { ...session, messageCount: counter(messages.length + 1) };
		unit.put('sessions', session);
		messages = messagesIn(unit, session);
	}
	const history = sessionHistory(unit, game, session, messages);
	return { game, session, messages, history };
}
function sessionHistory(
	unit: StorageUnit,
	game: Game,
	session: Session,
	messages: Message[]
): SessionHistory {
	const gameId = game.id;
	let history: SessionHistory;
	const saved = unit.get('progress', session.id);
	if (saved === undefined) {
		if (messages.some((message) => message.kind !== 'opening')) {
			throw new Error('세션의 진행 기록이 없어요.');
		}
		// Identical authored content reuses the shared snapshot row instead of copying it.
		const snapshot = contentSnapshot(unit, gameId, game);
		const progress = createSessionState(snapshot, session.id);
		unit.put('progress', progress);
		history = {
			snapshot,
			progress,
			transactions: [],
			checkpoints: unit
				.all('checkpoints')
				.map(parseSnapshotCheckpoint)
				.filter((row) => row.snapshotId === snapshot.id && row.sessionId === session.id),
			resources: snapshotResources(unit, snapshot.id)
		};
		return history;
	}
	const progress = parseSessionState(saved);
	const snapshot = parseGameSnapshot(unit.get('snapshots', progress.snapshotId));
	const transactions = unit
		.all('transactions')
		.map(parseTransaction)
		.sort((a, b) => a.createdRevision - b.createdRevision);
	history = {
		snapshot,
		progress,
		transactions,
		checkpoints: unit
			.all('checkpoints')
			.map(parseSnapshotCheckpoint)
			.filter((row) => row.snapshotId === snapshot.id && row.sessionId === session.id),
		resources: snapshotResources(unit, snapshot.id)
	};
	if (
		progress.gameId !== gameId ||
		progress.sessionId !== session.id ||
		!sameValue(stateAt(history), progress.state)
	) {
		throw new Error('저장된 상태가 진행 기록과 일치하지 않아요.');
	}
	assertHistoryMessages(transactions, messages);
	return history;
}

type Context = ReturnType<typeof initialize>;
function visibleMessages(context: Context): Message[] {
	const byId = new Map(context.messages.map((message) => [message.id, message]));
	const opening = context.messages.find((message) => message.kind === 'opening');
	const messages = opening ? [opening] : [];
	for (const node of activeTransactions(context.history)) {
		if (node.messageId !== undefined) {
			const message = byId.get(node.messageId);
			if (!message) {
				throw new Error('진행 기록에 연결된 메시지를 찾을 수 없어요.');
			}
			messages.push(message);
		}
	}
	return messages;
}
/** Shared application operations; the host owns the short SQL transactions. */
export interface GameRepositoryOptions {
	validateTransaction?: TransactionValidator;
	runAction?: ActionRunner;
	requestAI?: (
		gameId: string,
		sessionId: string,
		input: {
			text: string;
			visible: boolean;
		}
	) => void;
}
export function createGameRepository(
	rawTransport: StorageTransport,
	options: GameRepositoryOptions = {}
) {
	return new GameRepository(rawTransport, options);
}
class GameRepository {
	private rawTransport: StorageTransport;
	private options: GameRepositoryOptions;
	constructor(rawTransport: StorageTransport, options: GameRepositoryOptions = {}) {
		this.rawTransport = rawTransport;
		this.options = options;
	}
	private uiEvents = createSessionEvents();
	private publish = (
		gameId: string,
		sessionId: string,
		transactionId: string,
		events: import('./scripting/protocol.js').UIEvent[]
	) => {
		const failures = this.uiEvents.publish(gameId, sessionId, transactionId, events);
		for (const event of events) {
			if (
				event.name === '$helia.ai' &&
				typeof event.payload.text === 'string' &&
				!isSessionBusy(gameId, sessionId)
			) {
				const input = { text: event.payload.text, visible: event.payload.visible === true };
				queueMicrotask(() => {
					try {
						this.options.requestAI?.(gameId, sessionId, input);
					} catch {
						/* Post-commit invocation cannot undo its originating transaction. */
					}
				});
			}
		}
		return failures;
	};
	private changeListeners = new Map<string, Set<() => void>>();
	private changeKey = (gameId: string, sessionId: string) => JSON.stringify([gameId, sessionId]);
	private transport: StorageTransport = async (request) => {
		if (
			request.kind === 'commit' &&
			!request.aiLease &&
			[
				...request.records
					.filter((row) => ['progress', 'messages', 'transactions'].includes(row.table))
					.map((row) => row.sessionId),
				...request.deleteSessions
			].some((id) => id && isSessionBusy(request.gameId, id))
		) {
			throw aiError('busy');
		}
		if (request.kind === 'prune' && isSessionBusy(request.gameId, request.sessionId)) {
			throw aiError('busy');
		}
		const reply = await this.rawTransport(request);
		if (request.kind === 'commit' || request.kind === 'prune' || request.kind === 'create') {
			const sessionIds =
				request.kind === 'prune'
					? [request.sessionId]
					: [
							...request.records.flatMap((row) => (row.sessionId ? [row.sessionId] : [])),
							...(request.kind === 'commit' ? request.deleteSessions : [])
						];
			for (const sessionId of new Set(sessionIds)) {
				this.notifySession(request.gameId, sessionId);
			}
		}
		return reply;
	};
	private notifySession = (gameId: string, sessionId: string) => {
		for (const listener of [
			...(this.changeListeners.get(this.changeKey(gameId, sessionId)) ?? [])
		]) {
			try {
				listener();
			} catch {
				/* Observers never turn a successful commit into a failure. */
			}
		}
	};

	private withGame = <T>(gameId: string, operation: (unit: StorageUnit) => T) => {
		return useStorage(this.transport, gameId, undefined, operation);
	};
	private withHistory = <T>(
		gameId: string,
		sessionId: string,
		operation: (unit: StorageUnit, context: Context) => T,
		runOptions: RunOptions = {}
	) => {
		const scoped: StorageTransport = (command) => {
			if (runOptions.signal?.aborted) {
				throw aiError('canceled');
			}
			return this.transport(
				command.kind === 'commit' && runOptions.lease
					? { ...command, aiLease: runOptions.lease }
					: command
			);
		};
		return useStorage(scoped, gameId, sessionId, (unit) =>
			operation(unit, initialize(unit, gameId, sessionId))
		);
	};
	private commit = (
		unit: StorageUnit,
		context: Context,
		input: CommitTransaction & {
			message?: Pick<Message, 'role' | 'content'>;
		}
	) => {
		const message = input.message
			? makeMessage(context.session, counter((context.session.messageCount ?? 0) + 1), {
					role: input.message.role,
					content: validateMessageContent(input.message.content),
					kind: 'dialogue'
				})
			: undefined;
		const prepared = prepareTransaction(
			context.history,
			input,
			{
				id: crypto.randomUUID(),
				createdAt: new Date().toISOString(),
				...(message ? { messageId: message.id } : {})
			},
			this.options.validateTransaction
		);
		unit.put('transactions', prepared.transaction);
		unit.put('progress', prepared.progress);
		if (message) {
			unit.put('messages', message);
		}
		const now = prepared.transaction.createdAt;
		const session = {
			...context.session,
			...(message ? { messageCount: message.sequence } : {}),
			updatedAt: now
		};
		unit.put('sessions', session);
		unit.put('games', { ...context.game, updatedAt: now });
		return {
			history: {
				...context.history,
				progress: prepared.progress,
				transactions: [...context.history.transactions, prepared.transaction]
			},
			session,
			message
		};
	};
	private getTimeline = (gameId: string, sessionId: string): Promise<SessionTimeline> => {
		return this.withHistory(gameId, sessionId, (unit, context) => ({
			session: context.session,
			history: context.history,
			events: historyEvents(context.history, context.messages),
			messages: visibleMessages(context),
			memories: activeMemories(context.history, unit.all('memories').map(parseMemory))
		}));
	};
	private executeWork = async (
		context: Context,
		input: Omit<CommitTransaction, 'nextState'> & {
			message?: Pick<Message, 'role' | 'content'>;
			operation?: ActionRequest['operation'];
		},
		runOptions: RunOptions = {}
	) => {
		if (!this.options.runAction) {
			throw new CreatorRuntimeError('unavailable');
		}
		const gameId = context.game.id,
			sessionId = context.session.id;
		let session = context.session,
			message: Message | undefined;
		const history = await executeSessionWork(
			context.history,
			input,
			{
				run: this.options.runAction,
				read: () => this.withHistory(gameId, sessionId, (_unit, next) => next.history),
				commit: (proposal, snapshotId) =>
					this.withHistory(
						gameId,
						sessionId,
						(unit, next) => {
							if (runOptions.signal?.aborted) {
								throw new CreatorRuntimeError('canceled');
							}
							if (
								next.history.progress.revision !== proposal.expectedRevision ||
								next.history.snapshot.id !== snapshotId
							) {
								throw new CreatorRuntimeError('conflict');
							}
							const saved = this.commit(unit, next, proposal);
							session = saved.session;
							if (saved.message) {
								message = saved.message;
							}
							return saved.history;
						},
						runOptions
					),
				publish: (transactionId, events) => this.publish(gameId, sessionId, transactionId, events)
			},
			runOptions
		);
		return { history, session, message };
	};
	private deleteEvent = async (
		gameId: string,
		sessionId: string,
		eventId: string,
		expectedRevision: number
	): Promise<SessionTimeline> => {
		await this.transport({ kind: 'prune', gameId, sessionId, eventId, expectedRevision });
		return this.getTimeline(gameId, sessionId);
	};
	commitSessionAgent = async (
		gameId: string,
		sessionId: string,
		input: {
			expectedRevision: number;
			snapshotId: string;
			input: string;
			visible: boolean;
			result: AgentWorkspaceResult;
		},
		runOptions: RunOptions = {}
	) => {
		const saved = await this.withHistory(
			gameId,
			sessionId,
			(unit, context) => {
				if (runOptions.signal?.aborted) {
					throw aiError('canceled');
				}
				assertRevision(context.history.progress, input.expectedRevision);
				if (context.history.snapshot.id !== input.snapshotId) {
					throw new CreatorRuntimeError('conflict');
				}
				let current = context;
				if (input.visible) {
					const user = this.commit(unit, current, {
						expectedRevision: current.history.progress.revision,
						parentId: current.history.progress.headId,
						nextState: current.history.progress.state,
						action: { name: 'sendMessage', args: { content: input.input } },
						message: { role: 'user', content: input.input }
					});
					current = {
						...current,
						history: user.history,
						session: user.session,
						messages: [...current.messages, user.message!]
					};
				}
				const assistant = this.commit(unit, current, {
					expectedRevision: current.history.progress.revision,
					parentId: current.history.progress.headId,
					nextState: input.result.state,
					action: { name: '$helia.ai', args: { input: input.input } },
					description: 'AI 응답',
					message: { role: 'assistant', content: input.result.text }
				});
				const completed = {
					...current,
					history: assistant.history,
					session: assistant.session,
					messages: [...current.messages, assistant.message!]
				};
				return {
					session: completed.session,
					history: completed.history,
					events: historyEvents(completed.history, completed.messages),
					messages: visibleMessages(completed),
					memories: activeMemories(completed.history, unit.all('memories').map(parseMemory))
				};
			},
			runOptions
		);
		this.publish(gameId, sessionId, saved.history.progress.headId!, input.result.events);
		return saved;
	};
	executeSessionAgentHook = async (
		gameId: string,
		sessionId: string,
		{ name, trigger }: { name: string; trigger: RuleTrigger },
		runOptions: RunOptions = {}
	) => {
		const context = await this.withHistory(gameId, sessionId, (_unit, context) => context);
		return this.executeWork(
			context,
			{
				expectedRevision: context.history.progress.revision,
				parentId: context.history.progress.headId,
				action: { name: `hook:${name}`, args: {} },
				operation: { kind: 'hook', name, trigger }
			},
			runOptions
		);
	};
	subscribeSessionChanges = (gameId: string, sessionId: string, listener: () => void) => {
		identifier(gameId);
		identifier(sessionId);
		const key = this.changeKey(gameId, sessionId);
		const listeners = this.changeListeners.get(key) ?? new Set<() => void>();
		listeners.add(listener);
		this.changeListeners.set(key, listeners);
		return () => {
			listeners.delete(listener);
			if (!listeners.size) {
				this.changeListeners.delete(key);
			}
		};
	};
	subscribeSessionEvents = this.uiEvents.subscribe;
	getSessionTimeline = this.getTimeline;
	deleteSessionEvent = this.deleteEvent;
	listGames = async (includeTrashed = false) => {
		const result = await this.transport({ kind: 'list', includeTrashed });
		return result.records
			.map((row) => parseGame(row.value))
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	};
	/** Moving to Trash keeps every owned row; the timestamp is the only change. */
	trashGame = async (gameId: string) => {
		const result = await this.transport({ kind: 'trash', gameId });
		return parseGame(result.records.find((row) => row.table === 'games')?.value);
	};
	restoreGame = async (gameId: string) => {
		const result = await this.transport({ kind: 'restore', gameId });
		return parseGame(result.records.find((row) => row.table === 'games')?.value);
	};
	/** Permanent removal from the Trash. Only trashed games can be purged. */
	purgeGame = async (gameId: string) => {
		await this.transport({ kind: 'purge', gameId });
	};
	createGame = async (input: GameMetadata = { title: '새 게임', genre: '', description: '' }) => {
		const metadata = validateGameMetadata(input);
		const now = new Date().toISOString();
		const gameId = crypto.randomUUID();
		const session = makeSession(gameId);
		const game: Game = {
			...metadata,
			schemaVersion: 2,
			id: gameId,
			activeSessionId: session.id,
			createdAt: now,
			updatedAt: now,
			settings: { description: '', firstMessage: '', authorNote: '' },
			...emptyStateDocument(),
			scripts: {}
		};
		await this.transport({
			kind: 'create',
			gameId,
			records: [storedRecord('games', game), storedRecord('sessions', session)]
		});
		return game;
	};
	getGameWorkspace = (gameId: string) => {
		return this.withGame(gameId, (unit) => {
			if (unit.get('games', gameId) === undefined) {
				return null;
			}
			const game = gameIn(unit, gameId);
			const sessions = unit
				.all('sessions')
				.map(parseSession)
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
			if (!sessions.some((session) => session.id === game.activeSessionId)) {
				throw new Error('선택된 세션을 찾을 수 없어요.');
			}
			return { game, sessions };
		});
	};
	updateGame = (gameId: string, input: GameMetadata) => {
		const metadata = validateGameMetadata(input);
		return this.withGame(gameId, (unit) => {
			const game = { ...gameIn(unit, gameId), ...metadata, updatedAt: new Date().toISOString() };
			unit.put('games', game);
			return game;
		});
	};
	updateGameSettings = (gameId: string, input: UpdateGameSettings) => {
		const { title, ...settings } = validateGameSettings(input);
		return this.withGame(gameId, (unit) => {
			const game = {
				...gameIn(unit, gameId),
				title,
				settings,
				updatedAt: new Date().toISOString()
			};
			unit.put('games', game);
			return game;
		});
	};
	applyGameDraft = async (
		gameId: string,
		input: {
			baseContent: GameEditorContent;
			content: GameEditorContent;
		}
	) => {
		const content = input.content.code
			? {
					...input.content,
					...(await compileCodeProject(input.content.code, input.content.schema)),
					code: input.content.code
				}
			: input.content;
		return useStorage(
			(request) =>
				this.transport(request.kind === 'read' ? { ...request, includeHistory: true } : request),
			gameId,
			undefined,
			(unit) => {
				const previous = gameIn(unit, gameId);
				const base = parseGame({
					...previous,
					...input.baseContent,
					ui: input.baseContent.ui,
					ai: input.baseContent.ai,
					resources: input.baseContent.resources,
					code: input.baseContent.code,
					id: previous.id,
					activeSessionId: previous.activeSessionId
				});
				if (
					!sameValue(parseGameState(editorContent(previous)), parseGameState(editorContent(base)))
				) {
					throw new Error(
						'다른 화면에서 게임이 변경되었어요. 초안을 보존한 뒤 최신 게임을 다시 불러와주세요.'
					);
				}
				const game = parseGame({
					...previous,
					...content,
					ui: content.ui,
					ai: content.ai,
					resources: content.resources,
					code: content.code,
					id: previous.id,
					activeSessionId: previous.activeSessionId,
					createdAt: previous.createdAt,
					updatedAt: new Date().toISOString()
				});
				this.migrateSessions(unit, game);
				unit.put('games', game);
				return game;
			}
		);
	};
	private migrateSessions = (unit: StorageUnit, game: Game) => {
		const gameId = game.id;
		for (const raw of unit.all('sessions')) {
			const session = parseSession(raw);
			const saved = unit.get('progress', session.id);
			if (saved === undefined) {
				continue;
			}
			if (isSessionBusy(gameId, session.id)) {
				throw Error('실행 중인 작업이 끝난 뒤 적용해주세요.');
			}
			const progress = parseSessionState(saved);
			const snapshot = parseGameSnapshot(unit.get('snapshots', progress.snapshotId));
			const transactions = unit
				.all('transactions')
				.map(parseTransaction)
				.filter((node) => node.sessionId === session.id);
			const history: SessionHistory = {
				snapshot,
				progress,
				transactions,
				checkpoints: unit
					.all('checkpoints')
					.map(parseSnapshotCheckpoint)
					.filter((row) => row.snapshotId === snapshot.id && row.sessionId === session.id),
				resources: snapshotResources(unit, snapshot.id)
			};
			const transform = (state: import('./state/value.js').GameState) =>
				migrateState(state, snapshot.schema, game.schema, game.initialState);
			// The migrated content becomes a new shared snapshot row; per-event checkpoints
			// live in their own table so prune can drop rows instead of rewriting documents.
			const nextSnapshot = contentSnapshot(unit, gameId, {
				...game,
				schema: game.schema,
				initialState: transform(snapshot.initialState)
			});
			for (const node of transactions) {
				unit.put('checkpoints', {
					schemaVersion: 1,
					id: node.id,
					transactionId: node.id,
					snapshotId: nextSnapshot.id,
					gameId,
					sessionId: session.id,
					state: transform(stateAt(history, node.id))
				});
			}
			unit.put('progress', {
				...progress,
				snapshotId: nextSnapshot.id,
				revision: counter(progress.revision + 1),
				state: transform(stateAt(history))
			});
		}
	};

	updateGameRules = (
		gameId: string,
		input: Pick<Game, 'schema' | 'initialState' | 'scripts' | 'ui' | 'ai'>
	) => {
		const { schema, initialState } = parseStateDocument({
			schema: input.schema,
			initialState: input.initialState
		});
		const scripts = parseScripts(input.scripts);
		const ui = input.ui === undefined ? undefined : parseGameUI(input.ui);
		const ai = input.ai === undefined ? undefined : parseGameAIContent(input.ai);
		return this.withGame(gameId, (unit) => {
			const game = {
				...gameIn(unit, gameId),
				initialState,
				schema,
				scripts,
				...(ui ? { ui } : {}),
				...(ai ? { ai } : {}),
				updatedAt: new Date().toISOString()
			};
			unit.put('games', game);
			return game;
		});
	};
	createSession = (gameId: string) => {
		return this.withGame(gameId, (unit) => {
			const game = gameIn(unit, gameId);
			const session = makeSession(gameId);
			unit.put('sessions', session);
			unit.put('games', { ...game, activeSessionId: session.id, updatedAt: session.createdAt });
			return session;
		});
	};
	selectSession = (gameId: string, sessionId: string): Promise<void> => {
		return this.withGame(gameId, (unit) => {
			const { game } = owner(unit, gameId, sessionId);
			unit.put('games', { ...game, activeSessionId: sessionId });
		});
	};
	renameSession = (gameId: string, sessionId: string, input: string) => {
		const title = validateSessionTitle(input);
		return this.withGame(gameId, (unit) => {
			const { game, session } = owner(unit, gameId, sessionId);
			const now = new Date().toISOString();
			const updated = { ...session, title, updatedAt: now };
			unit.put('sessions', updated);
			unit.put('games', { ...game, updatedAt: now });
			return updated;
		});
	};
	deleteSession = (gameId: string, sessionId: string) => {
		return this.withGame(gameId, (unit) => {
			const { game } = owner(unit, gameId, sessionId);
			unit.deleteSession(sessionId);
			const sessions = unit
				.all('sessions')
				.map(parseSession)
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
			if (!sessions.length) {
				const session = makeSession(gameId);
				unit.put('sessions', session);
				sessions.push(session);
			}
			const updated = {
				...game,
				activeSessionId: game.activeSessionId === sessionId ? sessions[0].id : game.activeSessionId,
				updatedAt: new Date().toISOString()
			};
			unit.put('games', updated);
			return { game: updated, sessions };
		});
	};
	getSessionConversation = (gameId: string, sessionId: string) => {
		return this.withHistory(gameId, sessionId, (_unit, context) => ({
			session: context.session,
			messages: visibleMessages(context)
		}));
	};
	appendUserMessage = (
		gameId: string,
		sessionId: string,
		input: string,
		runOptions: RunOptions = {}
	) => {
		const content = validateMessageContent(input);
		return this.withHistory(gameId, sessionId, (unit, context) => {
			if (runOptions.signal?.aborted) {
				throw new CreatorRuntimeError('canceled');
			}
			if (Object.keys(context.history.snapshot.scripts).length) {
				return { kind: 'pending', context } as const;
			}
			const result = this.commit(unit, context, {
				expectedRevision: context.history.progress.revision,
				parentId: context.history.progress.headId,
				nextState: context.history.progress.state,
				action: { name: 'sendMessage', args: { content } },
				message: { role: 'user', content }
			});
			return {
				kind: 'saved',
				result: { session: result.session, message: result.message! }
			} as const;
		}).then(async (prepared) => {
			if (prepared.kind === 'saved') {
				return prepared.result;
			}
			const { context } = prepared;
			const result = await this.executeWork(
				context,
				{
					expectedRevision: context.history.progress.revision,
					parentId: context.history.progress.headId,
					action: { name: 'sendMessage', args: { content } },
					message: { role: 'user', content },
					operation: { kind: 'proposal', state: context.history.progress.state }
				},
				runOptions
			);
			return { session: result.session, message: result.message! };
		});
	};
	getSessionHistory = (gameId: string, sessionId: string) => {
		return this.withHistory(gameId, sessionId, (_unit, context) => context.history);
	};
	executeSessionAction = async (
		gameId: string,
		sessionId: string,
		input: {
			expectedRevision: number;
			action: CommitTransaction['action'];
		},
		runOptions: RunOptions = {}
	) => {
		const revision = counter(input.expectedRevision);
		const action = parseAction(input.action);
		const context = await this.withHistory(gameId, sessionId, (_unit, context) => {
			assertRevision(context.history.progress, revision);
			return context;
		});
		return (
			await this.executeWork(
				context,
				{ expectedRevision: revision, parentId: context.history.progress.headId, action },
				runOptions
			)
		).history;
	};
	commitSessionTransaction = (
		gameId: string,
		sessionId: string,
		input: CommitTransaction & {
			message?: Pick<Message, 'role' | 'content'>;
		},
		runOptions: RunOptions = {}
	): Promise<
		SessionHistory & {
			execution?: ExecutionReport;
		}
	> => {
		const message = input.message
			? { role: input.message.role, content: validateMessageContent(input.message.content) }
			: undefined;
		if (message && !['user', 'assistant'].includes(message.role)) {
			throw new Error('메시지 역할이 올바르지 않아요.');
		}
		const detached = {
			expectedRevision: counter(input.expectedRevision),
			parentId: input.parentId === null ? null : identifier(input.parentId),
			nextState: parseGameState(input.nextState),
			action: parseAction(input.action),
			...(input.description === undefined ? {} : { description: identifier(input.description) }),
			...(message ? { message } : {})
		};
		return this.withHistory(gameId, sessionId, (unit, context) => {
			if (runOptions.signal?.aborted) {
				throw new CreatorRuntimeError('canceled');
			}
			assertRevision(context.history.progress, detached.expectedRevision);
			if (Object.keys(context.history.snapshot.scripts).length) {
				return { kind: 'pending', context } as const;
			}
			return { kind: 'saved', history: this.commit(unit, context, detached).history } as const;
		}).then(async (prepared) => {
			if (prepared.kind === 'saved') {
				return prepared.history;
			}
			return (
				await this.executeWork(
					prepared.context,
					{
						...detached,
						operation: { kind: 'proposal', state: detached.nextState }
					},
					runOptions
				)
			).history;
		});
	};
	selectSessionBranch = (
		gameId: string,
		sessionId: string,
		headId: string | null,
		expectedRevision: number
	) => {
		return this.withHistory(gameId, sessionId, (unit, context) => {
			const progress = checkoutHistory(context.history, headId, expectedRevision);
			unit.put('progress', progress);
			return { ...context.history, progress };
		});
	};
	deleteSessionResponse = async (
		gameId: string,
		sessionId: string,
		transactionId: string,
		expectedRevision: number
	) => {
		const timeline = await this.getTimeline(gameId, sessionId);
		assertRevision(timeline.history.progress, expectedRevision);
		const event = timeline.events.find((event) => event.id === transactionId);
		if (event?.message?.role !== 'assistant' || event.message.kind !== 'dialogue') {
			throw new Error('이 세션의 AI 응답이 아니에요.');
		}
		return (await this.deleteEvent(gameId, sessionId, transactionId, expectedRevision)).history;
	};
	saveSessionMemory = (
		gameId: string,
		sessionId: string,
		expectedRevision: number,
		input: {
			sourceTransactionIds: string[];
			content: string;
		}
	) => {
		const memory = parseMemory({
			schemaVersion: 1,
			id: crypto.randomUUID(),
			gameId,
			sessionId,
			createdAt: new Date().toISOString(),
			...input
		});
		return this.withHistory(gameId, sessionId, (unit, context) => {
			assertRevision(context.history.progress, expectedRevision);
			if (!activeMemories(context.history, [memory]).length) {
				throw new Error('현재 진행 경로에 속한 기억만 저장할 수 있어요.');
			}
			unit.put('memories', memory);
			return memory;
		});
	};
	listSessionMemories = (gameId: string, sessionId: string) => {
		return this.withHistory(gameId, sessionId, (unit, context) =>
			activeMemories(context.history, unit.all('memories').map(parseMemory))
		);
	};
}

function assertHistoryMessages(transactions: SessionHistory['transactions'], messages: Message[]) {
	const ids = new Set(messages.map((message) => message.id));
	if (transactions.some((node) => node.messageId !== undefined && !ids.has(node.messageId))) {
		throw new Error('진행 기록에 연결된 메시지를 찾을 수 없어요.');
	}
}
