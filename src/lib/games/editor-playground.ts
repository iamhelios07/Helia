import {
	storedRecord,
	CONFLICT,
	type StoredRecord,
	type StorageTransport
} from '#lib/storage/protocol.js';

import type { AgentOptions, ToolDefinition } from './ai/protocol.js';
import type { SessionTimeline } from './state/history.js';
import type { GameUIRuntime } from './ui/runtime/bridge.js';

import { invokeSessionAI } from './ai/browser.js';
import { editorContent } from './editor.js';
import { parseGame, type Game } from './model.js';
import { createGameRepository } from './repository-core.js';
import { runCreatorAction } from './scripting/browser.js';
import { CreatorRuntimeError, type ActionRunner } from './scripting/protocol.js';
import { parseAction, type SessionHistory } from './state/model.js';
import { parseGameState, type GameState } from './state/value.js';

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
	if (error instanceof CreatorRuntimeError) {
		return JSON.stringify({
			code: error.code,
			scriptId: error.scriptId,
			ruleId: error.ruleId,
			reason: error.reason
		});
	}
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
	for (const row of [storedRecord('games', game), storedRecord('sessions', session)]) {
		rows.set(`${row.table}:${row.id}`, row);
	}
	return async (request) => {
		if (request.kind === 'list') {
			return { version, records: [...rows.values()].filter((row) => row.table === 'games') };
		}
		if (request.gameId !== game.id) {
			throw Error('다른 게임의 테스트 저장소에 접근할 수 없어요.');
		}
		if (request.kind === 'read') {
			return structuredClone({
				version,
				records: [...rows.values()].filter(
					(row) =>
						row.table === 'games' ||
						row.table === 'sessions' ||
						row.sessionId === null ||
						row.sessionId === request.sessionId
				)
			});
		}
		if (request.kind !== 'commit') {
			throw Error('테스트 저장소는 읽기와 커밋만 지원해요.');
		}
		if (request.version !== version) {
			throw Error(CONFLICT);
		}
		const next = new Map(rows);
		for (const row of request.records) {
			if (row.gameId !== game.id || (row.sessionId && row.sessionId !== game.activeSessionId)) {
				throw Error('다른 세션의 테스트 저장소에 접근할 수 없어요.');
			}
			next.set(`${row.table}:${row.id}`, structuredClone(row));
		}
		if (request.deleteSessions.length) {
			throw Error('테스트 세션을 직접 삭제할 수 없어요.');
		}
		rows = next;
		return { version: ++version, records: [] };
	};
}

export type EditorPlaythrough = Awaited<ReturnType<typeof createEditorPlaythrough>>;

export async function createEditorPlaythrough(source: Game, options: PlaygroundOptions = {}) {
	return new PlaygroundSession(source, options).initialize();
}
class PlaygroundSession {
	private readonly game: Game;
	private readonly fingerprint: string;
	private abort = new AbortController();
	private disposed = false;
	private refreshing: Promise<void> | undefined;
	private dirty = false;
	private timeline!: SessionTimeline;
	private seenTransactions = new Set<string>();
	private diagnostic = (message: string, failed = false, detail?: unknown) => {
		if (this.disposed) {
			return;
		}
		this.options.ondiagnostic?.({
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
	private run: ActionRunner = async (input, runOptions = {}) => {
		const operation = input.operation?.kind ?? 'action';
		const name =
			input.operation?.kind === 'hook' || input.operation?.kind === 'query'
				? input.operation.name
				: input.action.name;
		try {
			const result = await (this.options.runAction ?? runCreatorAction)(input, {
				...runOptions,
				signal: AbortSignal.any([
					this.abort.signal,
					...(runOptions.signal ? [runOptions.signal] : [])
				])
			});
			this.diagnostic(`${operation} · ${name} 완료`, false, {
				before: input.state,
				after: result.state,
				events: result.events,
				independentHooks: result.independentHooks
			});
			return result;
		} catch (error) {
			this.diagnostic(`${operation} · ${name} 실패`, true, playgroundFailure(error));
			throw error;
		}
	};
	private readonly repository: ReturnType<typeof createGameRepository>;
	private refresh = async () => {
		this.dirty = true;
		if (!this.refreshing) {
			this.refreshing = (async () => {
				try {
					while (this.dirty && !this.disposed) {
						this.dirty = false;
						const next = await this.repository.getSessionTimeline(
							this.game.id,
							this.game.activeSessionId
						);
						if (this.disposed) {
							return;
						}
						this.timeline = next;
						this.recordTransactions(next);
						this.options.onchange?.(next);
					}
				} finally {
					this.refreshing = undefined;
				}
			})();
		}
		return this.refreshing;
	};
	private recordTransactions(next: SessionTimeline): void {
		for (const event of next.events) {
			if (this.seenTransactions.has(event.id)) {
				continue;
			}
			this.seenTransactions.add(event.id);
			this.diagnostic(`트랜잭션 · ${event.action.name}`, false, {
				id: event.id,
				parentId: event.parentId,
				changes: event.changes
			});
		}
	}
	private readonly unsubscribe: () => void;
	private readonly unsubscribeEvents: () => void;
	private aiBusy = false;
	private ai = async (
		text: string,
		input: {
			visible?: boolean;
		} = {},
		aiOptions: AgentOptions = {}
	) => {
		if (this.disposed) {
			throw Error('종료된 테스트예요.');
		}
		if (this.aiBusy) {
			throw Error('AI 응답을 기다려주세요.');
		}
		this.aiBusy = true;
		try {
			const result = await invokeSessionAI(
				this.game.id,
				this.game.activeSessionId,
				{ text, ...input },
				{
					...aiOptions,
					runtime: { ...this.repository, runAction: this.run },
					signal: AbortSignal.any([
						this.abort.signal,
						...(aiOptions.signal ? [aiOptions.signal] : [])
					]),
					onEvent: (event) => {
						if (['status', 'tool', 'error'].includes(event.type)) {
							this.diagnostic(
								`AI · ${event.type}`,
								event.type === 'error' || (event.type === 'tool' && event.status === 'failed'),
								event
							);
						}
						aiOptions.onEvent?.(event);
					}
				}
			);
			await this.refresh();
			return result;
		} catch (error) {
			this.diagnostic('AI 실행 실패', true, playgroundFailure(error));
			throw error;
		} finally {
			this.aiBusy = false;
		}
	};
	private readonly runtime: GameUIRuntime;
	constructor(
		source: Game,
		private readonly options: PlaygroundOptions
	) {
		this.game = parseGame({
			...structuredClone(source),
			id: crypto.randomUUID(),
			activeSessionId: crypto.randomUUID()
		});
		this.fingerprint = playgroundFingerprint(source);
		this.repository = createGameRepository(playgroundStorage(this.game), {
			runAction: this.run,
			requestAI: (_gameId, _sessionId, input) => {
				void this.ai(input.text, { visible: input.visible }).catch(() => {});
			}
		});
		this.runtime = {
			...this.repository,
			invokeSessionAI: (_gameId, _sessionId, input, aiOptions) =>
				this.ai(input.text, input, aiOptions)
		};
		this.unsubscribe = this.repository.subscribeSessionChanges(
			this.game.id,
			this.game.activeSessionId,
			() => {
				void this.refresh().catch((error) =>
					this.diagnostic('테스트 상태 조회 실패', true, playgroundFailure(error))
				);
			}
		);
		this.unsubscribeEvents = this.repository.subscribeSessionEvents(
			this.game.id,
			this.game.activeSessionId,
			(event) => this.diagnostic('UI 이벤트', false, event)
		);
	}
	async initialize() {
		await this.refresh();
		return this.handle();
	}
	private handle() {
		const readTimeline = () => this.timeline;
		const readBusy = () => this.aiBusy;
		return {
			game: this.game,
			fingerprint: this.fingerprint,
			runtime: this.runtime,
			get timeline() {
				return readTimeline();
			},
			get busy() {
				return readBusy();
			},
			catalog: async (): Promise<ToolDefinition[]> => {
				const result = await this.run({
					scripts: this.game.scripts,
					schema: this.game.schema,
					state: this.timeline.history.progress.state,
					action: { name: '$catalog', args: {} },
					operation: { kind: 'catalog' }
				});
				return result.tools ?? [];
			},
			action: async (name: string, args: GameState): Promise<SessionHistory> => {
				if (this.disposed) {
					throw Error('종료된 테스트예요.');
				}
				const result = await this.repository.executeSessionAction(
					this.game.id,
					this.game.activeSessionId,
					{
						expectedRevision: this.timeline.history.progress.revision,
						action: parseAction({ name, args })
					},
					{ signal: this.abort.signal }
				);
				await this.refresh();
				return result;
			},
			transaction: async (nextState: GameState) => {
				if (this.disposed) {
					throw Error('종료된 테스트예요.');
				}
				const result = await this.repository.commitSessionTransaction(
					this.game.id,
					this.game.activeSessionId,
					{
						expectedRevision: this.timeline.history.progress.revision,
						parentId: this.timeline.history.progress.headId,
						action: { name: 'editor.test', args: {} },
						nextState: parseGameState(nextState)
					},
					{ signal: this.abort.signal }
				);
				await this.refresh();
				return result;
			},
			ai: this.ai,
			dispose: () => {
				if (this.disposed) {
					return;
				}
				this.disposed = true;
				this.abort.abort();
				this.unsubscribe();
				this.unsubscribeEvents();
			}
		};
	}
}
