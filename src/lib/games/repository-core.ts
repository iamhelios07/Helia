import type { TransactionValidator } from '#lib/games/state/workspace.js';
import type { InstallRequest, InstallResult, InstallPreviewEntry } from '#lib/storage/install.js';

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
	record,
	parseAction,
	parseGameSnapshot,
	parseMemory,
	parseSnapshotCheckpoint,
	parseSnapshotResource,
	parseSessionState,
	parseTransaction,
	transactionMessageIds,
	type SessionHistory
} from '#lib/games/state/model.js';
import {
	emptyStateDocument,
	parseObjectSchema,
	parseStateDocument,
	validateState
} from '#lib/games/state/schema.js';
import { parseGameState, sameValue } from '#lib/games/state/value.js';
import {
	parseBlob,
	storedRecord,
	type StorageRequest,
	type StorageTransport
} from '#lib/storage/protocol.js';
import { useStorage, type StorageUnit } from '#lib/storage/unit.js';

import type { AgentWorkspaceResult } from './ai/loop.js';
import type { GameResource, GameResources } from './resources.js';
import type { RuleTrigger } from './scripting/protocol.js';
import type {
	GameVersioning,
	GameRelease,
	GameReleaseOptions,
	CreateGameReleaseResult
} from './versioning.js';

import { isSessionBusy } from './ai/activity.js';
import { agentMessages } from './ai/message-echo.js';
import { parseGameAIContent } from './ai/prompts.js';
import { aiError } from './ai/protocol.js';
import { compileCodeProject } from './code-project.js';
import { assertEditOperation } from './edit-lock.js';
import { editorContent, type GameEditorContent } from './editor.js';
import { LockedPlayRuntimeCache } from './locked-play-runtime.js';
import { migrationStates, type StateResolver } from './migration/inputs.js';
import { defaultResolver } from './migration/precompute.js';
import {
	parseGame,
	parseSession,
	parseMessage,
	parseMessageInput,
	parseScripts,
	validateGameMetadata,
	validateGameSettings,
	validateSessionTitle,
	validateMessageContent,
	type Game,
	type Session,
	type Message,
	type MessageInput,
	type GameMetadata,
	type UpdateGameSettings
} from './model.js';
import { runtimeReady } from './runtime-ready.js';
import { gameActions } from './scripting/game-scope.js';
import { NO_BASELINES, type MigrationSource } from './state/baseline.js';
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

function resourceBlobId(gameId: string, asset: GameResource): string {
	if (asset.data.startsWith('helia-asset:')) {
		return asset.data.slice(12);
	}
	// The blob table has a global primary key but every row has one game owner.
	return contentHash([gameId, asset.data]);
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
		...(game.ai ? { ai: game.ai } : {})
	};
	const resources = Object.fromEntries(
		Object.entries(game.resources ?? {}).map(([assetId, asset]) => [
			assetId,
			{
				name: asset.name,
				mime: asset.mime,
				blobId: resourceBlobId(gameId, asset)
			}
		])
	);
	const id = contentHash({ ...content, resources });
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
		const fingerprint = resources[assetId].blobId;
		if (!asset.data.startsWith('helia-asset:') && unit.get('blobs', fingerprint) === undefined) {
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
			id: contentHash([gameId, id, assetId, fingerprint]),
			snapshotId: id,
			gameId,
			blobId: fingerprint,
			assetId,
			name
		});
	}
	return snapshot;
}
/** Snapshot resources retain v2 references; legacy blobs retain their inline data. */
function snapshotResources(unit: StorageUnit, snapshotId: string): GameResources {
	const result: GameResources = {};
	for (const reference of unit
		.all('snapshot_resources')
		.map(parseSnapshotResource)
		.filter((row) => row.snapshotId === snapshotId)) {
		const saved = unit.get('blobs', reference.blobId);
		const blob = saved === undefined ? undefined : parseBlob(saved);
		if (!blob) {
			const current = gameIn(unit, reference.gameId).resources?.[reference.assetId];
			if (!current) {
				throw new Error('리소스 데이터를 찾을 수 없어요.');
			}
			result[reference.assetId] = {
				name: reference.name,
				mime: current.mime,
				data: 'helia-asset:' + reference.blobId
			};
		} else {
			result[reference.assetId] = {
				name: reference.name,
				mime: blob.mime,
				data: blob.schemaVersion === 2 ? 'helia-asset:' + blob.id : blob.data
			};
		}
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
		for (const id of transactionMessageIds(node)) {
			const message = byId.get(id);
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
	runTurn?: (
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
	private lockedPlayRuntime = new LockedPlayRuntimeCache();
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
						this.options.runTurn?.(gameId, sessionId, input);
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
	/** First-use snapshots retain portable source, never transport-only artifact references. */
	private readPlay = async (command: Extract<StorageRequest, { kind: 'read' }>) => {
		const reply = await this.transport({ ...command, play: true });
		const saved = reply.records.find((row) => row.table === 'games');
		if (!saved) {
			return reply;
		}
		const sessionId = command.sessionId ?? parseGame(saved.value).activeSessionId;
		if (reply.records.some((row) => row.table === 'progress' && row.sessionId === sessionId)) {
			return reply;
		}
		await useStorage(this.transport, command.gameId, sessionId, (unit) =>
			initialize(unit, command.gameId, sessionId)
		);
		return this.transport({ ...command, play: true });
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
			if (command.kind === 'read') {
				return this.readPlay(command);
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
			messages?: MessageInput[];
		}
	) => {
		const messages = [...(input.message ? [input.message] : []), ...(input.messages ?? [])].map(
			(value, index) =>
				makeMessage(context.session, counter((context.session.messageCount ?? 0) + index + 1), {
					...parseMessageInput(value),
					kind: 'dialogue'
				})
		);
		const message = messages[0];
		const prepared = prepareTransaction(
			context.history,
			input,
			{
				id: crypto.randomUUID(),
				createdAt: new Date().toISOString(),
				...(message ? { messageId: message.id } : {}),
				...(messages.length > 1 ? { messageIds: messages.map((message) => message.id) } : {})
			},
			this.options.validateTransaction
		);
		unit.put('transactions', prepared.transaction);
		unit.put('progress', prepared.progress);
		for (const item of messages) {
			unit.put('messages', item);
		}
		const now = prepared.transaction.createdAt;
		const session = {
			...context.session,
			...(messages.length ? { messageCount: messages.at(-1)!.sequence } : {}),
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
			message,
			messages
		};
	};
	private getTimeline = (
		gameId: string,
		sessionId: string,
		graph = true
	): Promise<SessionTimeline> => {
		return this.withHistory(gameId, sessionId, (unit, context) => ({
			session: context.session,
			history: context.history,
			events: graph ? historyEvents(context.history, context.messages) : [],
			messages: visibleMessages(context),
			memories: activeMemories(context.history, unit.all('memories').map(parseMemory))
		}));
	};
	private executeWork = async (
		context: Context,
		input: Omit<CommitTransaction, 'nextState'> & {
			message?: Pick<Message, 'role' | 'content'>;
			messages?: MessageInput[];
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
				run: gameActions(this.options.runAction, gameId),
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
					messages: agentMessages(input.result.text, input.result.messages)
				});
				const completed = {
					...current,
					history: assistant.history,
					session: assistant.session,
					messages: [...current.messages, ...assistant.messages]
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
	getPlayTimeline = (gameId: string, sessionId: string) =>
		this.getTimeline(gameId, sessionId, false);
	deleteSessionEvent = this.deleteEvent;
	listGames = async (includeTrashed = false) => {
		const result = await this.transport({ kind: 'list', includeTrashed });
		return (result.games ?? []).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
			originalGameId: crypto.randomUUID(),
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
	getGameVersioning = async (gameId: string): Promise<GameVersioning> => {
		const reply = await this.transport({ kind: 'versioning', action: 'read', gameId });
		if (!reply.versioning) {
			throw Error('Missing game versioning');
		}
		return reply.versioning;
	};
	unlockGame = async (gameId: string): Promise<void> => {
		await this.transport({ kind: 'unlockGame', gameId });
	};
	installPreview = async (
		originalGameId: string,
		contentVersion: string
	): Promise<InstallPreviewEntry[]> => {
		const reply = await this.transport({ kind: 'installPreview', originalGameId, contentVersion });
		if (!reply.installPreview) {
			throw Error('Missing install preview');
		}
		return reply.installPreview;
	};
	install = async (
		input: Omit<InstallRequest, 'kind' | 'gameId' | 'sessionId'>
	): Promise<InstallResult> => {
		const reply = await this.transport({
			...input,
			kind: 'install',
			gameId: crypto.randomUUID(),
			sessionId: crypto.randomUUID()
		});
		if (!reply.installResult) {
			throw Error('Missing install result');
		}
		return reply.installResult;
	};
	createGameRelease = async (
		gameId: string,
		contentVersion: string,
		options: GameReleaseOptions = {}
	): Promise<CreateGameReleaseResult> => {
		const reply = await this.transport({
			kind: 'versioning',
			action: 'release',
			gameId,
			contentVersion,
			...options
		});
		if (!reply.releaseResult) {
			throw Error('Missing release result');
		}
		return reply.releaseResult;
	};
	getGameRelease = async (gameId: string, releaseId: string): Promise<GameRelease> => {
		const reply = await this.transport({
			kind: 'versioning',
			action: 'getRelease',
			gameId,
			releaseId
		});
		if (!reply.release) {
			throw Error('Missing game release');
		}
		return reply.release;
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
	getPlayWorkspace = (gameId: string) => this.loadPlayWorkspace(gameId);
	private loadPlayWorkspace = async (
		gameId: string,
		lockedRuntimePrepared = false
	): Promise<{ game: Game; sessions: Session[]; timeline: SessionTimeline } | null> => {
		const workspace = await useStorage(
			(request) => (request.kind === 'read' ? this.readPlay(request) : this.transport(request)),
			gameId,
			undefined,
			(unit) => {
				if (!unit.get('games', gameId)) {
					return null;
				}
				const game = gameIn(unit, gameId),
					sessions = unit
						.all('sessions')
						.map(parseSession)
						.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
				const context = initialize(unit, gameId, game.activeSessionId);
				const timeline = {
					session: context.session,
					history: context.history,
					events: [],
					messages: visibleMessages(context),
					memories: activeMemories(context.history, unit.all('memories').map(parseMemory))
				};
				return { game, sessions, timeline };
			}
		);
		if (workspace?.game.editLock === true) {
			return this.prepareLockedPlay(gameId, workspace, lockedRuntimePrepared);
		}
		if (workspace && !runtimeReady(workspace.game)) {
			const original = (await this.getGameWorkspace(gameId))!.game;
			await this.applyGameDraft(gameId, {
				baseContent: editorContent(original),
				content: editorContent(original)
			});
			return this.getPlayWorkspace(gameId);
		}
		if (workspace && !runtimeReady(workspace.timeline.history.snapshot)) {
			await this.prepareRuntimeSnapshot(gameId, workspace.game.activeSessionId);
			return this.getPlayWorkspace(gameId);
		}
		return workspace;
	};
	/** Installed source remains immutable; only the session's derived runtime snapshot is stored. */
	private prepareLockedPlay = async (
		gameId: string,
		workspace: { game: Game; sessions: Session[]; timeline: SessionTimeline },
		runtimePrepared: boolean
	) => {
		// Play transport strips source and build keys. Compare the portable stored runtime instead.
		const { original, snapshot } = await useStorage(
			this.transport,
			gameId,
			workspace.game.activeSessionId,
			(unit) => ({
				original: gameIn(unit, gameId),
				snapshot: parseGameSnapshot(unit.get('snapshots', workspace.timeline.history.snapshot.id))
			})
		);
		const compiled = await this.lockedPlayRuntime.prepare(original);
		const normalized = {
			scripts: parseScripts(compiled.scripts),
			ui: compiled.ui === undefined ? undefined : parseGameUI(compiled.ui)
		};
		if (
			!runtimeReady(snapshot) ||
			contentHash([snapshot.scripts, snapshot.ui]) !==
				contentHash([normalized.scripts, normalized.ui])
		) {
			if (runtimePrepared) {
				throw Error('잠긴 게임의 실행 스냅숏이 준비된 빌드와 일치하지 않아요. 다시 시도해주세요.');
			}
			await this.prepareRuntimeSnapshot(gameId, workspace.game.activeSessionId, compiled);
			return this.loadPlayWorkspace(gameId, true);
		}
		return {
			...workspace,
			game: { ...workspace.game, scripts: compiled.scripts, ui: compiled.ui }
		};
	};
	private prepareRuntimeSnapshot = async (
		gameId: string,
		sessionId: string,
		runtime?: Pick<Game, 'scripts' | 'ui'>
	) => {
		const original = await useStorage(
			this.transport,
			gameId,
			sessionId,
			(unit) => initialize(unit, gameId, sessionId).history
		);
		const compiled = runtime
			? { ...original.snapshot, scripts: runtime.scripts, ui: runtime.ui }
			: await (await import('./runtime-build.js')).buildRuntime(original.snapshot);
		const id = contentHash({
			...compiled,
			id: undefined,
			createdAt: undefined,
			code: undefined,
			snapshotId: original.snapshot.id
		});
		return this.withHistory(gameId, sessionId, (unit, context) => {
			if (
				context.history.snapshot.id !== original.snapshot.id ||
				context.history.progress.revision !== original.progress.revision
			) {
				throw Error('Session changed during runtime preparation');
			}
			unit.put('snapshots', { ...compiled, id, createdAt: new Date().toISOString() });
			for (const raw of unit.all('snapshot_resources')) {
				const resource = parseSnapshotResource(raw);
				if (resource.snapshotId === original.snapshot.id) {
					unit.put('snapshot_resources', {
						...resource,
						id: contentHash([gameId, id, resource.assetId, resource.blobId]),
						snapshotId: id
					});
				}
			}
			for (const transaction of original.transactions) {
				unit.put('checkpoints', {
					schemaVersion: 1,
					id: transaction.id,
					transactionId: transaction.id,
					snapshotId: id,
					gameId,
					sessionId,
					state: stateAt(original, transaction.id)
				});
			}
			unit.put('progress', {
				...original.progress,
				snapshotId: id,
				revision: original.progress.revision + 1
			});
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
		const source = input.content.code
			? {
					...input.content,
					...(await compileCodeProject(input.content.code, input.content.schema)),
					code: input.content.code
				}
			: input.content;
		const content = await (await import('./runtime-build.js')).buildRuntime(source);
		return useStorage(
			(request) =>
				this.transport(request.kind === 'read' ? { ...request, includeHistory: true } : request),
			gameId,
			undefined,
			(unit) => {
				const previous = gameIn(unit, gameId);
				assertEditOperation(previous.editLock, 'apply');
				const base = parseGame({
					...previous,
					...input.baseContent,
					ui: input.baseContent.ui,
					ai: input.baseContent.ai,
					regex: input.baseContent.regex,
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
					regex: content.regex,
					resources: content.resources,
					code: content.code,
					id: previous.id,
					activeSessionId: previous.activeSessionId,
					createdAt: previous.createdAt,
					updatedAt: new Date().toISOString()
				});
				// Chat rules are live creator configuration; changing them alone leaves branches intact.
				if (
					!sameValue(
						parseGameState({ ...editorContent(previous), regex: [] }),
						parseGameState({ ...editorContent(game), regex: [] })
					)
				) {
					this.migrateSessions(
						{ unit, baselines: NO_BASELINES },
						game,
						defaultResolver({
							game,
							schemaOf: (id) => parseObjectSchema(record(unit.get('snapshots', id)).schema)
						})
					);
				}
				unit.put('games', game);
				return game;
			}
		);
	};
	private migrateSessions = (source: MigrationSource, game: Game, resolve: StateResolver) => {
		const { unit } = source;
		let snapshotId = '';
		for (const input of migrationStates(source)) {
			const { sessionId, role } = input;
			if (isSessionBusy(game.id, sessionId)) {
				throw Error('실행 중인 작업이 끝난 뒤 적용해주세요.');
			}
			const state = validateState(game.schema, resolve(input), 'load');
			if (role === 'initial') {
				snapshotId = contentSnapshot(unit, game.id, { ...game, initialState: state }).id;
			} else if (role === 'checkpoint') {
				unit.put('checkpoints', {
					schemaVersion: 1,
					id: input.transactionId!,
					transactionId: input.transactionId!,
					snapshotId,
					gameId: game.id,
					sessionId,
					state
				});
			} else {
				const progress = parseSessionState(unit.get('progress', sessionId));
				unit.put('progress', {
					...progress,
					snapshotId,
					revision: counter(progress.revision + 1),
					state
				});
			}
		}
	};

	updateGameRules = async (
		gameId: string,
		input: Pick<Game, 'schema' | 'initialState' | 'scripts' | 'ui' | 'ai'>
	) => {
		const { schema, initialState } = parseStateDocument({
			schema: input.schema,
			initialState: input.initialState
		});
		const parsedScripts = parseScripts(input.scripts);
		const parsedUI = input.ui === undefined ? undefined : parseGameUI(input.ui);
		const { scripts, ui } = await (
			await import('./runtime-build.js')
		).buildRuntime({ scripts: parsedScripts, ui: parsedUI, schema });
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
	appendSessionMessage = async (
		gameId: string,
		sessionId: string,
		input: { expectedRevision: number; message: MessageInput },
		runOptions: RunOptions = {}
	) => {
		const message = parseMessageInput(input.message);
		const context = await this.withHistory(
			gameId,
			sessionId,
			(_unit, context) => context,
			runOptions
		);
		return this.commitSessionTransaction(
			gameId,
			sessionId,
			{
				expectedRevision: input.expectedRevision,
				parentId: context.history.progress.headId,
				nextState: context.history.progress.state,
				action: { name: '$helia.appendMessage', args: {} },
				message
			},
			runOptions
		);
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
		if (
			!(event?.messages ?? (event?.message ? [event.message] : [])).some(
				(message) => message.role === 'assistant' && message.kind === 'dialogue'
			)
		) {
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
	if (transactions.some((node) => transactionMessageIds(node).some((id) => !ids.has(id)))) {
		throw new Error('진행 기록에 연결된 메시지를 찾을 수 없어요.');
	}
}
