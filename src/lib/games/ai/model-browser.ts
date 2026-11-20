import { providerAddress } from '#lib/app/settings/credential-protocol.js';
import { loadAISettings } from '#lib/app/settings/repository.js';

import { modelMessages, parseModelCall, type ModelResponse } from './model-call.js';
import { aiError, type AgentOptions } from './protocol.js';
import { beginGeneration } from './transport.js';

/** A single model request. No prompt assembly, tools execution or repository writes. */
export async function callSessionModel(
	gameId: string,
	sessionId: string,
	input: unknown,
	options: AgentOptions = {}
): Promise<ModelResponse> {
	const request = parseModelCall(input);
	const settings = await loadAISettings();
	const selected =
		request.model === 'auxiliary' ? settings.auxiliaryModelId : settings.defaultModelId;
	const model = settings.models.find((model) => model.id === selected);
	const provider = settings.providers.find((provider) => provider.id === model?.providerId);
	if (!model || !provider) {
		throw new Error(
			request.model === 'auxiliary'
				? '앱 설정에서 보조 모델을 선택해주세요.'
				: '앱 설정에서 기본 모델을 선택해주세요.'
		);
	}
	const messages = modelMessages(request.messages, provider.kind, model.modelId);
	const signal = options.signal ?? new AbortController().signal;
	if (signal.aborted) {
		throw aiError('canceled');
	}
	const scope = await beginGeneration(gameId, sessionId);
	const cancel = () => {
		void scope.release().catch(() => {});
	};
	signal.addEventListener('abort', cancel, { once: true });
	try {
		if (signal.aborted) {
			throw aiError('canceled');
		}
		const round = await scope.generate(
			{
				provider: providerAddress(provider),
				model: model.modelId,
				messages,
				tools: (request.tools ?? []).map((tool) => ({
					...tool,
					description: tool.description ?? '',
					kind: 'query'
				})),
				maxTokens: model.maxOutputTokens ?? 4096
			},
			signal,
			options.onEvent ?? (() => {})
		);
		if (signal.aborted) {
			throw aiError('canceled');
		}
		return {
			content: round.content ?? (round.text ? [{ type: 'text', text: round.text }] : []),
			toolCalls: round.calls,
			...(round.native
				? { continuation: { provider: provider.kind, model: model.modelId, data: round.native } }
				: {}),
			...(round.usage ? { usage: round.usage } : {})
		};
	} finally {
		signal.removeEventListener('abort', cancel);
		await scope.release().catch(() => {});
	}
}
