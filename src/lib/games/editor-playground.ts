import { createGameRepository } from './repository-core.js';
import { parseGame, type Game } from './model.js';
import { editorContent } from './editor.js';
import {
	storedRecord,
	CONFLICT,
	type StoredRecord,
	type StorageTransport
} from '#lib/storage/protocol.js';
import { runCreatorAction } from './scripting/browser.js';
import { CreatorRuntimeError, type ActionRunner } from './scripting/protocol.js';
import { parseAction, type SessionHistory } from './state/model.js';
import { parseGameState, type GameState } from './state/value.js';
import type { SessionTimeline } from './state/history.js';
import { invokeSessionAI } from './ai/browser.js';
import type { AgentOptions, ToolDefinition } from './ai/protocol.js';
import type { GameUIRuntime } from './ui/runtime/bridge.js';

export interface EditorDiagnostic {
	message: string;
	failed: boolean;
	detail?: string;
}
export interface PlaygroundOptions {
	ondiagnostic?: (entry: EditorDiagnostic) => void;
	onchange?: (timeline: SessionTimeline) => void;
	runAction?: ActionRunner;
}

export function playgroundFingerprint(game: Game): string {
	return JSON.stringify(editorContent(game));
}

/** Diagnostics include only creator/runtime data, never provider configuration or credentials. */
export function playgroundFailure(error: unknown): string {
	if (error instanceof CreatorRuntimeError)
		return JSON.stringify({
			code: error.code,
			scriptId: error.scriptId,
			ruleId: error.ruleId,
			reason: error.reason
		});
	return error instanceof Error ? error.message.slice(0, 2000) : '실행 오류';
}

/** A private working set with no storage transport, IDs, or sessions shared with normal play. */
function playgroundStorage(game: Game): StorageTransport {
	let version = 0;
	let rows = new Map<string, StoredRecord>();
	const session = {
		schemaVersion: 1,
		id: game.activeSessionId,
		gameId: game.id,
		title: '편집기 테스트',
		createdAt: game.createdAt,
		updatedAt: game.updatedAt,
		messageCount: 0
	};
	for (const row of [storedRecord('games', game), storedRecord('sessions', session)])
		rows.set(`${row.table}:${row.id}`, row);
	return async (request) => {
		if (request.kind === 'list')
			return { version, records: [...rows.values()].filter((row) => row.table === 'games') };
		if (request.gameId !== game.id) throw Error('다른 게임의 테스트 저장소에 접근할 수 없어요.');
		if (request.kind === 'read')
			return structuredClone({
				version,
				records: [...rows.values()].filter(
					(row) =>
						row.table === 'games' || row.table === 'sessions' || row.sessionId === request.sessionId
				)
			});
		if (request.kind !== 'commit') throw Error('테스트 저장소는 읽기와 커밋만 지원해요.');
		if (request.version !== version) throw Error(CONFLICT);
		const next = new Map(rows);
		for (const row of request.records) {
			if (row.gameId !== game.id || (row.sessionId && row.sessionId !== game.activeSessionId))
				throw Error('다른 세션의 테스트 저장소에 접근할 수 없어요.');
			next.set(`${row.table}:${row.id}`, structuredClone(row));
		}
		if (request.deleteSessions.length) throw Error('테스트 세션을 직접 삭제할 수 없어요.');
		rows = next;
		return { version: ++version, records: [] };
	};
}

export type EditorPlaythrough = Awaited<ReturnType<typeof createEditorPlaythrough>>;

export async function createEditorPlaythrough(source: Game, options: PlaygroundOptions = {}) {
	const game = parseGame({
		...structuredClone(source),
		id: crypto.randomUUID(),
		activeSessionId: crypto.randomUUID()
	});
	const fingerprint = playgroundFingerprint(source);
	const abort = new AbortController();
	let disposed = false;
	let refreshing: Promise<void> | undefined;
	let dirty = false;
	let timeline: SessionTimeline;
	const seenTransactions = new Set<string>();
	const diagnostic = (message: string, failed = false, detail?: unknown) => {
		if (disposed) return;
		options.ondiagnostic?.({
			message,
			failed,
			...(detail === undefined
				? {}
				: {
						detail:
							typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2).slice(0, 16000)
					})
		});
	};
	const run: ActionRunner = async (input, runOptions = {}) => {
		const operation = input.operation?.kind ?? 'action';
		const name =
			input.operation?.kind === 'hook' || input.operation?.kind === 'query'
				? input.operation.name
				: input.action.name;
		try {
			const result = await (options.runAction ?? runCreatorAction)(input, {
				...runOptions,
				signal: AbortSignal.any([abort.signal, ...(runOptions.signal ? [runOptions.signal] : [])])
			});
			diagnostic(`${operation} · ${name} 완료`, false, {
				before: input.state,
				after: result.state,
				events: result.events,
				independentHooks: result.independentHooks
			});
			return result;
		} catch (error) {
			diagnostic(`${operation} · ${name} 실패`, true, playgroundFailure(error));
			throw error;
		}
	};
	const repository = createGameRepository(playgroundStorage(game), {
		runAction: run,
		requestAI: (_gameId, _sessionId, input) => {
			void ai(input.text, { visible: input.visible }).catch(() => {});
		}
	});
	async function refresh() {
		dirty = true;
		if (!refreshing)
			refreshing = (async () => {
				try {
					while (dirty && !disposed) {
						dirty = false;
						const next = await repository.getSessionTimeline(game.id, game.activeSessionId);
						if (disposed) return;
						timeline = next;
						for (const event of next.events)
							if (!seenTransactions.has(event.id)) {
								seenTransactions.add(event.id);
								diagnostic(`트랜잭션 · ${event.action.name}`, false, {
									id: event.id,
									parentId: event.parentId,
									changes: event.changes
								});
							}
						options.onchange?.(next);
					}
				} finally {
					refreshing = undefined;
				}
			})();
		return refreshing;
	}
	const unsubscribe = repository.subscribeSessionChanges(game.id, game.activeSessionId, () => {
		void refresh().catch((error) =>
			diagnostic('테스트 상태 조회 실패', true, playgroundFailure(error))
		);
	});
	const unsubscribeEvents = repository.subscribeSessionEvents(
		game.id,
		game.activeSessionId,
		(event) => diagnostic('UI 이벤트', false, event)
	);
	let aiBusy = false;
	async function ai(text: string, input: { visible?: boolean } = {}, aiOptions: AgentOptions = {}) {
		if (disposed) throw Error('종료된 테스트예요.');
		if (aiBusy) throw Error('AI 응답을 기다려주세요.');
		aiBusy = true;
		try {
			const result = await invokeSessionAI(
				game.id,
				game.activeSessionId,
				{ text, ...input },
				{
					...aiOptions,
					signal: AbortSignal.any([abort.signal, ...(aiOptions.signal ? [aiOptions.signal] : [])]),
					onEvent: (event) => {
						if (['status', 'tool', 'error'].includes(event.type))
							diagnostic(
								`AI · ${event.type}`,
								event.type === 'error' || (event.type === 'tool' && event.status === 'failed'),
								event
							);
						aiOptions.onEvent?.(event);
					}
				},
				{ ...repository, runAction: run }
			);
			await refresh();
			return result;
		} catch (error) {
			diagnostic('AI 실행 실패', true, playgroundFailure(error));
			throw error;
		} finally {
			aiBusy = false;
		}
	}
	await refresh();
	const runtime: GameUIRuntime = {
		...repository,
		invokeSessionAI: (_gameId, _sessionId, input, aiOptions) => ai(input.text, input, aiOptions)
	};
	return {
		game,
		fingerprint,
		runtime,
		get timeline() {
			return timeline;
		},
		get busy() {
			return aiBusy;
		},
		async catalog(): Promise<ToolDefinition[]> {
			const result = await run({
				scripts: game.scripts,
				schema: game.schema,
				state: timeline.history.progress.state,
				action: { name: '$catalog', args: {} },
				operation: { kind: 'catalog' }
			});
			return result.tools ?? [];
		},
		async action(name: string, args: GameState): Promise<SessionHistory> {
			if (disposed) throw Error('종료된 테스트예요.');
			const result = await repository.executeSessionAction(
				game.id,
				game.activeSessionId,
				{
					expectedRevision: timeline.history.progress.revision,
					action: parseAction({ name, args })
				},
				{ signal: abort.signal }
			);
			await refresh();
			return result;
		},
		async transaction(nextState: GameState) {
			if (disposed) throw Error('종료된 테스트예요.');
			const result = await repository.commitSessionTransaction(
				game.id,
				game.activeSessionId,
				{
					expectedRevision: timeline.history.progress.revision,
					parentId: timeline.history.progress.headId,
					action: { name: 'editor.test', args: {} },
					nextState: parseGameState(nextState)
				},
				{ signal: abort.signal }
			);
			await refresh();
			return result;
		},
		ai,
		dispose() {
			if (disposed) return;
			disposed = true;
			abort.abort();
			unsubscribe();
			unsubscribeEvents();
		}
	};
}
