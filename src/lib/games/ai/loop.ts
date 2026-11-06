import type { SessionTimeline } from '#lib/games/state/history.js';
import type { ActionRunner, RuleTrigger, UIEvent } from '#lib/games/scripting/protocol.js';
import { parseGameState } from '#lib/games/state/value.js';
import { parsePromptConfig, assemblePrompt, type PromptConfig } from './prompts.js';
import {
	aiError,
	AI_LIMITS,
	type AgentEvent,
	type ModelGenerator,
	type RoundRequest,
	type AIMessage
} from './protocol.js';

export interface AgentWorkspaceResult {
	state: ReturnType<typeof parseGameState>;
	text: string;
	events: UIEvent[];
	hooks: { name: string; trigger: RuleTrigger }[];
}
export async function runAgentWorkspace(
	timeline: SessionTimeline,
	input: string,
	connection: Pick<RoundRequest, 'provider' | 'model'>,
	generate: ModelGenerator,
	run: ActionRunner,
	signal: AbortSignal,
	emit: (event: AgentEvent) => void,
	config?: PromptConfig
): Promise<AgentWorkspaceResult> {
	const snapshot = timeline.history.snapshot,
		ai = parsePromptConfig(config);
	const base = { scripts: snapshot.scripts, schema: snapshot.schema };
	let state = parseGameState(timeline.history.progress.state);
	const check = () => {
		if (signal.aborted) throw aiError('canceled');
	};
	check();
	const catalog = await run(
		{ ...base, state, action: { name: 'ai.catalog', args: {} }, operation: { kind: 'catalog' } },
		{ signal }
	);
	const tools = catalog.tools ?? [],
		events: UIEvent[] = [],
		hooks: AgentWorkspaceResult['hooks'] = [];
	const prompt = assemblePrompt(ai, {
		settings: snapshot.settings,
		lorebook: snapshot.ai?.lorebook,
		messages: timeline.messages,
		transactions: timeline.events
			.filter((e) => e.active)
			.map((e) => timeline.history.transactions.find((t) => t.id === e.id)!),
		memories: timeline.memories,
		state,
		input
	});
	// Replace the final state summary after every staged tool batch.
	prompt.pop();
	const transcript: AIMessage[] = [];
	let calls = 0;
	for (let round = 0; round < AI_LIMITS.rounds; round++) {
		check();
		const prefix = ai.promptSettings.assistantPrefill;
		const messages: AIMessage[] = [
			...prompt,
			...transcript,
			...(prefix ? [{ role: 'assistant' as const, content: prefix }] : []),
			{
				role: 'system',
				content: `Current game state (authoritative structured facts):\n${JSON.stringify(state)}`
			}
		];
		if (JSON.stringify(messages).length > ai.maxContextChars)
			throw new Error('AI 컨텍스트 한도를 초과했어요. 프롬프트나 대화 범위를 조정해주세요.');
		if (prefix) emit({ type: 'text', text: prefix });
		let output: Awaited<ReturnType<ModelGenerator>> | undefined;
		for (let retry = 0; retry <= AI_LIMITS.retries; retry++) {
			let observed = false;
			try {
				output = await generate(
					{
						...connection,
						tools,
						maxTokens: ai.maxTokens,
						messages
					},
					signal,
					(event) => {
						observed = true;
						emit(event);
					}
				);
				break;
			} catch (error) {
				if (observed || retry === AI_LIMITS.retries || signal.aborted) throw error;
			}
		}
		if (!output) throw aiError();
		check();
		if (!output.calls.length) {
			if (!output.text.trim()) throw aiError('protocol');
			const validated = await run(
				{
					...base,
					state: timeline.history.progress.state,
					action: { name: '$helia.ai', args: { input } },
					operation: { kind: 'validate', state }
				},
				{ signal }
			);
			check();
			return { state: validated.state, text: prefix + output.text, events, hooks };
		}
		emit({ type: 'reset' });
		if (prefix || output.text) emit({ type: 'progress', text: prefix + output.text });
		transcript.push({
			role: 'assistant',
			content: output.text,
			calls: output.calls,
			...(output.native ? { native: output.native } : {})
		});
		for (const call of output.calls) {
			check();
			if (++calls > AI_LIMITS.calls) throw aiError('limit');
			const tool = tools.find((t) => t.name === call.name);
			if (!tool) throw aiError('protocol');
			emit({ type: 'tool', name: call.name, status: 'running' });
			try {
				const before = state,
					args = parseGameState(call.arguments);
				const result = await run(
					{
						...base,
						state,
						action: { name: call.name, args },
						...(tool.kind === 'query'
							? { operation: { kind: 'query' as const, name: call.name, args } }
							: {})
					},
					{ signal }
				);
				check();
				if (tool.kind === 'action') {
					state = result.state;
					events.push(...(result.events ?? []));
					for (const name of result.independentHooks ?? [])
						hooks.push({
							name,
							trigger: { before, after: state, action: { name: call.name, args } }
						});
					if (events.length > 128 || hooks.length > 16) throw aiError('limit');
				}
				transcript.push({
					role: 'tool',
					callId: call.id,
					content: JSON.stringify(
						tool.kind === 'query' ? (result.value ?? null) : { ok: true, state }
					)
				});
				emit({ type: 'tool', name: call.name, status: 'completed' });
			} catch (error) {
				emit({ type: 'tool', name: call.name, status: 'failed' });
				throw error;
			}
		}
	}
	throw aiError('limit');
}
