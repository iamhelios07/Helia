import { loadAISettings } from '#lib/app/settings/repository.js';
import { loadSelectedPromptConfig } from '#lib/app/settings/prompt-repository.js';
import { providerAddress } from '#lib/app/settings/credential-protocol.js';
import {
	getSessionTimeline,
	commitSessionAgent,
	executeSessionAgentHook
} from '#lib/games/repository.js';
import { runCreatorAction } from '#lib/games/scripting/browser.js';
import { validateMessageContent } from '#lib/games/model.js';
import { beginSessionActivity, publishSessionAIEvent } from './activity.js';
import { aiError, AI_LIMITS, type AgentOptions } from './protocol.js';
import { runAgentWorkspace } from './loop.js';
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
	options: AgentOptions = {},
	runtime: SessionAIRuntime = defaultRuntime()
) {
	const text = validateMessageContent(input.text),
		settings = loadAISettings(),
		prompt = loadSelectedPromptConfig();
	const model = settings.models.find((m) => m.id === (input.modelId ?? settings.defaultModelId));
	if (!model) throw new Error('앱 설정에서 사용할 모델을 등록하고 선택해주세요.');
	const provider = settings.providers.find((p) => p.id === model.providerId);
	if (!provider) throw new Error('모델의 API 연결을 확인해주세요.');
	if (options.signal?.aborted) throw aiError('canceled');
	const timeline = await runtime.getSessionTimeline(gameId, sessionId),
		idle = beginSessionActivity(gameId, sessionId);
	const signal = AbortSignal.any([
		AbortSignal.timeout(AI_LIMITS.timeoutMs),
		...(options.signal ? [options.signal] : [])
	]);
	const emit: NonNullable<AgentOptions['onEvent']> = (event) => {
		publishSessionAIEvent(gameId, sessionId, event);
		try {
			options.onEvent?.(event);
		} catch {
			/* Presentation does not control commit. */
		}
	};
	let scope: Awaited<ReturnType<typeof beginGeneration>> | undefined;
	try {
		scope = await beginGeneration(gameId, sessionId);
		emit({ type: 'status', status: 'generating' });
		const cancel = () => {
			void scope?.release().catch(() => {});
		};
		signal.addEventListener('abort', cancel, { once: true });
		try {
			const result = await runAgentWorkspace(
				timeline,
				text,
				{ provider: providerAddress(provider), model: model.modelId },
				scope.generate,
				runtime.runAction,
				signal,
				emit,
				prompt
			);
			if (signal.aborted) throw aiError('canceled');
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
			for (const job of result.hooks) {
				if (signal.aborted) break;
				try {
					await runtime.executeSessionAgentHook(gameId, sessionId, job.name, job.trigger, {
						signal,
						lease: scope.lease
					});
				} catch {
					emit({ type: 'tool', name: job.name, status: 'failed' });
				}
			}
			return await runtime.getSessionTimeline(gameId, sessionId).catch(() => committed);
		} finally {
			signal.removeEventListener('abort', cancel);
		}
	} catch (error) {
		if (signal.aborted) throw aiError(options.signal?.aborted ? 'canceled' : 'timeout');
		throw error;
	} finally {
		await scope?.release().catch(() => {});
		idle();
	}
}
