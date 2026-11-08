import { providerAddress } from '#lib/app/settings/credential-protocol.js';
import { loadSelectedPromptConfig } from '#lib/app/settings/prompt-repository.js';
import { loadAISettings } from '#lib/app/settings/repository.js';
import { validateMessageContent } from '#lib/games/model.js';
import {
	getSessionTimeline,
	commitSessionAgent,
	executeSessionAgentHook
} from '#lib/games/repository.js';
import { runCreatorAction } from '#lib/games/scripting/browser.js';

import { beginSessionActivity, publishSessionAIEvent } from './activity.js';
import { runAgentWorkspace } from './loop.js';
import { aiError, AI_LIMITS, type AgentOptions } from './protocol.js';
import { beginGeneration } from './transport.js';

/** A separate repository lets authoring playthroughs use the same BYOK loop without live writes. */
export interface SessionAIRuntime {
	getSessionTimeline: typeof getSessionTimeline;
	commitSessionAgent: typeof commitSessionAgent;
	executeSessionAgentHook: typeof executeSessionAgentHook;
	runAction: typeof runCreatorAction;
}
function defaultRuntime(): SessionAIRuntime {
	return {
		getSessionTimeline,
		commitSessionAgent,
		executeSessionAgentHook,
		runAction: runCreatorAction
	};
}

export async function invokeSessionAI(
	gameId: string,
	sessionId: string,
	input: { text: string; visible?: boolean; modelId?: string },
	options: AgentOptions & { runtime?: SessionAIRuntime } = {}
) {
	const runtime = options.runtime ?? defaultRuntime();
	const text = validateMessageContent(input.text),
		settings = loadAISettings(),
		prompt = loadSelectedPromptConfig();
	const { model, provider } = selectedModelConnection(settings, input.modelId);
	if (options.signal?.aborted) {
		throw aiError('canceled');
	}
	const timeline = await runtime.getSessionTimeline(gameId, sessionId),
		idle = beginSessionActivity(gameId, sessionId);
	const signal = AbortSignal.any([
		AbortSignal.timeout(AI_LIMITS.timeoutMs),
		...(options.signal ? [options.signal] : [])
	]);
	const emit = createEmitter(gameId, sessionId, options.onEvent);
	let scope: Awaited<ReturnType<typeof beginGeneration>> | undefined;
	try {
		scope = await beginGeneration(gameId, sessionId);
		emit({ type: 'status', status: 'generating' });
		const cancel = () => {
			void scope?.release().catch(() => {});
		};
		signal.addEventListener('abort', cancel, { once: true });
		try {
			const result = await runAgentWorkspace(timeline, text, {
				connection: { provider: providerAddress(provider), model: model.modelId },
				generate: scope.generate,
				run: runtime.runAction,
				signal: signal,
				emit: emit,
				config: prompt
			});
			if (signal.aborted) {
				throw aiError('canceled');
			}
			emit({ type: 'status', status: 'committing' });
			const committed = await runtime.commitSessionAgent(
				gameId,
				sessionId,
				{
					expectedRevision: timeline.history.progress.revision,
					snapshotId: timeline.history.snapshot.id,
					input: text,
					visible: input.visible !== false,
					result
				},
				{ signal, lease: scope.lease }
			);
			emit({ type: 'status', status: 'committed' });
			// Follow-up failures cannot turn the already committed root into an apparent failure.
			await runFollowUpHooks({
				runtime,
				gameId,
				sessionId,
				hooks: result.hooks,
				signal,
				emit,
				lease: scope.lease
			});
			return await runtime.getSessionTimeline(gameId, sessionId).catch(() => committed);
		} finally {
			signal.removeEventListener('abort', cancel);
		}
	} catch (error) {
		if (signal.aborted) {
			throw aiError(options.signal?.aborted ? 'canceled' : 'timeout');
		}
		throw error;
	} finally {
		await scope?.release().catch(() => {});
		idle();
	}
}

async function runFollowUpHooks({
	runtime,
	gameId,
	sessionId,
	hooks,
	signal,
	emit,
	lease
}: {
	runtime: SessionAIRuntime;
	gameId: string;
	sessionId: string;
	hooks: import('./loop.js').AgentWorkspaceResult['hooks'];
	signal: AbortSignal;
	emit: NonNullable<AgentOptions['onEvent']>;
	lease: string;
}) {
	for (const job of hooks) {
		if (signal.aborted) {
			break;
		}
		try {
			await runtime.executeSessionAgentHook(gameId, sessionId, job, {
				signal,
				lease: lease
			});
		} catch {
			emit({ type: 'tool', name: job.name, status: 'failed' });
		}
	}
}

function selectedModelConnection(
	settings: ReturnType<typeof loadAISettings>,
	modelId: string | undefined
) {
	const model = settings.models.find((m) => m.id === (modelId ?? settings.defaultModelId));
	if (!model) {
		throw new Error('앱 설정에서 사용할 모델을 등록하고 선택해주세요.');
	}
	const provider = settings.providers.find((p) => p.id === model.providerId);
	if (!provider) {
		throw new Error('모델의 API 연결을 확인해주세요.');
	}
	return { model, provider };
}

function createEmitter(
	gameId: string,
	sessionId: string,
	onEvent: AgentOptions['onEvent']
): NonNullable<AgentOptions['onEvent']> {
	return (event) => {
		publishSessionAIEvent(gameId, sessionId, event);
		try {
			onEvent?.(event);
		} catch {
			/* Presentation does not control commit. */
		}
	};
}
