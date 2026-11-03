import { useStorage, type StorageUnit } from '#lib/storage/unit.js';
import { storedRecord, type StorageTransport } from '#lib/storage/protocol.js';
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
import {
	counter,
	identifier,
	parseAction,
	parseGameSnapshot,
	parseMemory,
	parseSessionState,
	parseTransaction,
	type SessionHistory
} from '#lib/games/state/model.js';
import { parseGameState, sameValue } from '#lib/games/state/value.js';
import { emptyStateDocument, parseStateDocument } from '#lib/games/state/schema.js';
import type { TransactionValidator } from '#lib/games/state/workspace.js';
import { historyEvents, type SessionTimeline } from '#lib/games/state/history.js';
import {
	CreatorRuntimeError,
	type ActionRunner,
	type RunOptions,
	type ActionRequest
} from '#lib/games/scripting/protocol.js';
import { executeSessionWork, type ExecutionReport } from '#lib/games/scripting/execution.js';
import { createSessionEvents } from '#lib/games/scripting/events.js';
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
	role: Message['role'],
	content: string,
	kind: Message['kind']
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
	if (value === undefined) throw new Error('게임을 찾을 수 없어요.');
	return parseGame(value);
}
function owner(unit: StorageUnit, gameId: string, sessionId: string) {
	const game = gameIn(unit, gameId);
	const value = unit.get('sessions', sessionId);
	if (value === undefined) throw new Error('세션을 찾을 수 없어요.');
	const session = parseSession(value);
	if (session.gameId !== gameId) throw new Error('이 게임에 속한 세션이 아니에요.');
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
	)
		throw new Error('저장된 채팅 기록을 확인할 수 없어요.');
	return messages;
}
function initialize(unit: StorageUnit, gameId: string, sessionId: string) {
	const { game, session: previous } = owner(unit, gameId, sessionId);
	let session = previous;
	let messages = messagesIn(unit, session);
	if (game.settings.firstMessage.trim() && messages[0]?.kind !== 'opening') {
		for (const message of messages)
			unit.put('messages', { ...message, sequence: counter(message.sequence + 1) });
		unit.put(
			'messages',
			makeMessage(session, 1, 'assistant', game.settings.firstMessage, 'opening')
		);
		session = { ...session, messageCount: counter(messages.length + 1) };
		unit.put('sessions', session);
		messages = messagesIn(unit, session);
	}
	let history: SessionHistory;
	const saved = unit.get('progress', session.id);
	if (saved === undefined) {
		if (messages.some((message) => message.kind !== 'opening'))
			throw new Error('세션의 진행 기록이 없어요.');
		const snapshot = parseGameSnapshot({
			schemaVersion: 1,
			id: crypto.randomUUID(),
			gameId,
			createdAt: new Date().toISOString(),
			settings: game.settings,
			initialState: game.initialState,
			schema: game.schema,
			scripts: game.scripts,
			...(game.ui ? { ui: game.ui } : {})
		});
		const progress = createSessionState(snapshot, session.id);
		unit.put('snapshots', snapshot, session.id);
		unit.put('progress', progress);
		history = { snapshot, progress, transactions: [] };
	} else {
		const progress = parseSessionState(saved);
		const snapshot = parseGameSnapshot(unit.get('snapshots', progress.snapshotId));
		const transactions = unit
			.all('transactions')
			.map(parseTransaction)
			.sort((a, b) => a.createdRevision - b.createdRevision);
		history = { snapshot, progress, transactions };
		if (
			progress.gameId !== gameId ||
			progress.sessionId !== session.id ||
			!sameValue(stateAt(history), progress.state)
		)
			throw new Error('저장된 상태가 진행 기록과 일치하지 않아요.');
		const ids = new Set(messages.map((message) => message.id));
		if (transactions.some((node) => node.messageId !== undefined && !ids.has(node.messageId)))
			throw new Error('진행 기록에 연결된 메시지를 찾을 수 없어요.');
	}
	return { game, session, messages, history };
}
type Context = ReturnType<typeof initialize>;
function visibleMessages(context: Context): Message[] {
	const byId = new Map(context.messages.map((message) => [message.id, message]));
	const opening = context.messages.find((message) => message.kind === 'opening');
	const messages = opening ? [opening] : [];
	for (const node of activeTransactions(context.history)) {
		if (node.messageId !== undefined) {
			const message = byId.get(node.messageId);
			if (!message) throw new Error('진행 기록에 연결된 메시지를 찾을 수 없어요.');
			messages.push(message);
		}
	}
	return messages;
}

/** Shared application operations; the host owns the short SQL transactions. */
export function createGameRepository(
	rawTransport: StorageTransport,
	options: { validateTransaction?: TransactionValidator; runAction?: ActionRunner } = {}
) {
	const uiEvents = createSessionEvents();
	const changeListeners = new Map<string, Set<() => void>>();
	const changeKey = (gameId: string, sessionId: string) => JSON.stringify([gameId, sessionId]);
	const transport: StorageTransport = async (request) => {
		const reply = await rawTransport(request);
		if (request.kind === 'commit' || request.kind === 'prune' || request.kind === 'create') {
			const sessionIds =
				request.kind === 'prune'
					? [request.sessionId]
					: [
							...request.records.flatMap((row) => (row.sessionId ? [row.sessionId] : [])),
							...(request.kind === 'commit' ? request.deleteSessions : [])
						];
			for (const sessionId of new Set(sessionIds))
				for (const listener of [
					...(changeListeners.get(changeKey(request.gameId, sessionId)) ?? [])
				]) {
					try {
						listener();
					} catch {
						/* Observers never turn a successful commit into a failure. */
					}
				}
		}
		return reply;
	};
	function withGame<T>(gameId: string, operation: (unit: StorageUnit) => T) {
		return useStorage(transport, gameId, undefined, operation);
	}
	function withHistory<T>(
		gameId: string,
		sessionId: string,
		operation: (unit: StorageUnit, context: Context) => T
	) {
		return useStorage(transport, gameId, sessionId, (unit) =>
			operation(unit, initialize(unit, gameId, sessionId))
		);
	}
	function commit(
		unit: StorageUnit,
		context: Context,
		input: CommitTransaction & { message?: Pick<Message, 'role' | 'content'> }
	) {
		const message = input.message
			? makeMessage(
					context.session,
					counter((context.session.messageCount ?? 0) + 1),
					input.message.role,
					validateMessageContent(input.message.content),
					'dialogue'
				)
			: undefined;
		const prepared = prepareTransaction(
			context.history,
			input,
			{
				id: crypto.randomUUID(),
				createdAt: new Date().toISOString(),
				...(message ? { messageId: message.id } : {})
			},
			options.validateTransaction
		);
		unit.put('transactions', prepared.transaction);
		unit.put('progress', prepared.progress);
		if (message) unit.put('messages', message);
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
	}
	function getTimeline(gameId: string, sessionId: string): Promise<SessionTimeline> {
		return withHistory(gameId, sessionId, (unit, context) => ({
			session: context.session,
			history: context.history,
			events: historyEvents(context.history, context.messages),
			messages: visibleMessages(context),
			memories: activeMemories(context.history, unit.all('memories').map(parseMemory))
		}));
	}
	async function executeWork(
		context: Context,
		input: Omit<CommitTransaction, 'nextState'> & {
			message?: Pick<Message, 'role' | 'content'>;
			operation?: ActionRequest['operation'];
		},
		runOptions: RunOptions = {}
	) {
		if (!options.runAction) throw new CreatorRuntimeError('unavailable');
		const gameId = context.game.id,
			sessionId = context.session.id;
		let session = context.session,
			message: Message | undefined;
		const history = await executeSessionWork(
			context.history,
			input,
			{
				run: options.runAction,
				read: () => withHistory(gameId, sessionId, (_unit, next) => next.history),
				commit: (proposal, snapshotId) =>
					withHistory(gameId, sessionId, (unit, next) => {
						if (runOptions.signal?.aborted) throw new CreatorRuntimeError('canceled');
						if (
							next.history.progress.revision !== proposal.expectedRevision ||
							next.history.snapshot.id !== snapshotId
						)
							throw new CreatorRuntimeError('conflict');
						const saved = commit(unit, next, proposal);
						session = saved.session;
						if (saved.message) message = saved.message;
						return saved.history;
					}),
				publish: (transactionId, events) =>
					uiEvents.publish(gameId, sessionId, transactionId, events)
			},
			runOptions
		);
		return { history, session, message };
	}
	async function deleteEvent(
		gameId: string,
		sessionId: string,
		eventId: string,
		expectedRevision: number
	): Promise<SessionTimeline> {
		await transport({ kind: 'prune', gameId, sessionId, eventId, expectedRevision });
		return getTimeline(gameId, sessionId);
	}
	return {
		subscribeSessionChanges(gameId: string, sessionId: string, listener: () => void) {
			identifier(gameId);
			identifier(sessionId);
			const key = changeKey(gameId, sessionId);
			const listeners = changeListeners.get(key) ?? new Set<() => void>();
			listeners.add(listener);
			changeListeners.set(key, listeners);
			return () => {
				listeners.delete(listener);
				if (!listeners.size) changeListeners.delete(key);
			};
		},
		subscribeSessionEvents: uiEvents.subscribe,
		getSessionTimeline: getTimeline,
		deleteSessionEvent: deleteEvent,
		async listGames() {
			const result = await transport({ kind: 'list' });
			return result.records
				.map((row) => parseGame(row.value))
				.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		},
		async createGame(input: GameMetadata = { title: '새 게임', genre: '', description: '' }) {
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
			await transport({
				kind: 'create',
				gameId,
				records: [storedRecord('games', game), storedRecord('sessions', session)]
			});
			return game;
		},
		getGameWorkspace(gameId: string) {
			return withGame(gameId, (unit) => {
				if (unit.get('games', gameId) === undefined) return null;
				const game = gameIn(unit, gameId);
				const sessions = unit
					.all('sessions')
					.map(parseSession)
					.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
				if (!sessions.some((session) => session.id === game.activeSessionId))
					throw new Error('선택된 세션을 찾을 수 없어요.');
				return { game, sessions };
			});
		},
		updateGame(gameId: string, input: GameMetadata) {
			const metadata = validateGameMetadata(input);
			return withGame(gameId, (unit) => {
				const game = { ...gameIn(unit, gameId), ...metadata, updatedAt: new Date().toISOString() };
				unit.put('games', game);
				return game;
			});
		},
		updateGameSettings(gameId: string, input: UpdateGameSettings) {
			const { title, ...settings } = validateGameSettings(input);
			return withGame(gameId, (unit) => {
				const game = {
					...gameIn(unit, gameId),
					title,
					settings,
					updatedAt: new Date().toISOString()
				};
				unit.put('games', game);
				return game;
			});
		},
		updateGameRules(
			gameId: string,
			input: Pick<Game, 'schema' | 'initialState' | 'scripts' | 'ui'>
		) {
			const { schema, initialState } = parseStateDocument({
				schema: input.schema,
				initialState: input.initialState
			});
			const scripts = parseScripts(input.scripts);
			const ui = input.ui === undefined ? undefined : parseGameUI(input.ui);
			return withGame(gameId, (unit) => {
				const game = {
					...gameIn(unit, gameId),
					initialState,
					schema,
					scripts,
					...(ui ? { ui } : {}),
					updatedAt: new Date().toISOString()
				};
				unit.put('games', game);
				return game;
			});
		},
		createSession(gameId: string) {
			return withGame(gameId, (unit) => {
				const game = gameIn(unit, gameId);
				const session = makeSession(gameId);
				unit.put('sessions', session);
				unit.put('games', { ...game, activeSessionId: session.id, updatedAt: session.createdAt });
				return session;
			});
		},
		selectSession(gameId: string, sessionId: string): Promise<void> {
			return withGame(gameId, (unit) => {
				const { game } = owner(unit, gameId, sessionId);
				unit.put('games', { ...game, activeSessionId: sessionId });
			});
		},
		renameSession(gameId: string, sessionId: string, input: string) {
			const title = validateSessionTitle(input);
			return withGame(gameId, (unit) => {
				const { game, session } = owner(unit, gameId, sessionId);
				const now = new Date().toISOString();
				const updated = { ...session, title, updatedAt: now };
				unit.put('sessions', updated);
				unit.put('games', { ...game, updatedAt: now });
				return updated;
			});
		},
		deleteSession(gameId: string, sessionId: string) {
			return withGame(gameId, (unit) => {
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
					activeSessionId:
						game.activeSessionId === sessionId ? sessions[0].id : game.activeSessionId,
					updatedAt: new Date().toISOString()
				};
				unit.put('games', updated);
				return { game: updated, sessions };
			});
		},
		getSessionConversation(gameId: string, sessionId: string) {
			return withHistory(gameId, sessionId, (_unit, context) => ({
				session: context.session,
				messages: visibleMessages(context)
			}));
		},
		appendUserMessage(
			gameId: string,
			sessionId: string,
			input: string,
			runOptions: RunOptions = {}
		) {
			const content = validateMessageContent(input);
			return withHistory(gameId, sessionId, (unit, context) => {
				if (runOptions.signal?.aborted) throw new CreatorRuntimeError('canceled');
				if (Object.keys(context.history.snapshot.scripts).length)
					return { kind: 'pending', context } as const;
				const result = commit(unit, context, {
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
				if (prepared.kind === 'saved') return prepared.result;
				const { context } = prepared;
				const result = await executeWork(
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
		},
		getSessionHistory(gameId: string, sessionId: string) {
			return withHistory(gameId, sessionId, (_unit, context) => context.history);
		},
		async executeSessionAction(
			gameId: string,
			sessionId: string,
			input: { expectedRevision: number; action: CommitTransaction['action'] },
			runOptions: RunOptions = {}
		) {
			const revision = counter(input.expectedRevision);
			const action = parseAction(input.action);
			const context = await withHistory(gameId, sessionId, (_unit, context) => {
				assertRevision(context.history.progress, revision);
				return context;
			});
			return (
				await executeWork(
					context,
					{ expectedRevision: revision, parentId: context.history.progress.headId, action },
					runOptions
				)
			).history;
		},
		commitSessionTransaction(
			gameId: string,
			sessionId: string,
			input: CommitTransaction & { message?: Pick<Message, 'role' | 'content'> },
			runOptions: RunOptions = {}
		): Promise<SessionHistory & { execution?: ExecutionReport }> {
			const message = input.message
				? { role: input.message.role, content: validateMessageContent(input.message.content) }
				: undefined;
			if (message && !['user', 'assistant'].includes(message.role))
				throw new Error('메시지 역할이 올바르지 않아요.');
			const detached = {
				expectedRevision: counter(input.expectedRevision),
				parentId: input.parentId === null ? null : identifier(input.parentId),
				nextState: parseGameState(input.nextState),
				action: parseAction(input.action),
				...(input.description === undefined ? {} : { description: identifier(input.description) }),
				...(message ? { message } : {})
			};
			return withHistory(gameId, sessionId, (unit, context) => {
				if (runOptions.signal?.aborted) throw new CreatorRuntimeError('canceled');
				assertRevision(context.history.progress, detached.expectedRevision);
				if (Object.keys(context.history.snapshot.scripts).length)
					return { kind: 'pending', context } as const;
				return { kind: 'saved', history: commit(unit, context, detached).history } as const;
			}).then(async (prepared) => {
				if (prepared.kind === 'saved') return prepared.history;
				return (
					await executeWork(
						prepared.context,
						{
							...detached,
							operation: { kind: 'proposal', state: detached.nextState }
						},
						runOptions
					)
				).history;
			});
		},
		selectSessionBranch(
			gameId: string,
			sessionId: string,
			headId: string | null,
			expectedRevision: number
		) {
			return withHistory(gameId, sessionId, (unit, context) => {
				const progress = checkoutHistory(context.history, headId, expectedRevision);
				unit.put('progress', progress);
				return { ...context.history, progress };
			});
		},
		async deleteSessionResponse(
			gameId: string,
			sessionId: string,
			transactionId: string,
			expectedRevision: number
		) {
			const timeline = await getTimeline(gameId, sessionId);
			assertRevision(timeline.history.progress, expectedRevision);
			const event = timeline.events.find((event) => event.id === transactionId);
			if (event?.message?.role !== 'assistant' || event.message.kind !== 'dialogue')
				throw new Error('이 세션의 AI 응답이 아니에요.');
			return (await deleteEvent(gameId, sessionId, transactionId, expectedRevision)).history;
		},
		saveSessionMemory(
			gameId: string,
			sessionId: string,
			expectedRevision: number,
			input: { sourceTransactionIds: string[]; content: string }
		) {
			const memory = parseMemory({
				schemaVersion: 1,
				id: crypto.randomUUID(),
				gameId,
				sessionId,
				createdAt: new Date().toISOString(),
				...input
			});
			return withHistory(gameId, sessionId, (unit, context) => {
				assertRevision(context.history.progress, expectedRevision);
				if (!activeMemories(context.history, [memory]).length)
					throw new Error('현재 진행 경로에 속한 기억만 저장할 수 있어요.');
				unit.put('memories', memory);
				return memory;
			});
		},
		listSessionMemories(gameId: string, sessionId: string) {
			return withHistory(gameId, sessionId, (unit, context) =>
				activeMemories(context.history, unit.all('memories').map(parseMemory))
			);
		}
	};
}
