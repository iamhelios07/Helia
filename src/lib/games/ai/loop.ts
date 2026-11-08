import type { ActionRunner, RuleTrigger, UIEvent } from '#lib/games/scripting/protocol.js';
import type { SessionTimeline } from '#lib/games/state/history.js';

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

export interface AgentWorkspaceOptions {
	connection: Pick<RoundRequest, 'provider' | 'model'>;
	generate: ModelGenerator;
	run: ActionRunner;
	signal: AbortSignal;
	emit: (event: AgentEvent) => void;
	config?: PromptConfig;
}
export async function runAgentWorkspace(
	timeline: SessionTimeline,
	input: string,
	options: AgentWorkspaceOptions
): Promise<AgentWorkspaceResult> {
	return new AgentWorkspace(timeline, input, options).execute();
}
class AgentWorkspace {
	private state: ReturnType<typeof parseGameState>;
	private ai: PromptConfig;
	private base: Pick<import('../scripting/protocol.js').ActionRequest, 'scripts' | 'schema'>;
	private tools: import('./protocol.js').ToolDefinition[] = [];
	private transcript: AIMessage[] = [];
	private events: UIEvent[] = [];
	private hooks: AgentWorkspaceResult['hooks'] = [];
	private calls = 0;
	constructor(
		private timeline: SessionTimeline,
		private input: string,
		private options: AgentWorkspaceOptions
	) {
		const snapshot = timeline.history.snapshot;
		this.ai = parsePromptConfig(options.config);
		this.base = { scripts: snapshot.scripts, schema: snapshot.schema };
		this.state = parseGameState(timeline.history.progress.state);
	}
	private check() {
		if (this.options.signal.aborted) {
			throw aiError('canceled');
		}
	}
	private prompt() {
		const { history, messages, events, memories } = this.timeline;
		const prompt = assemblePrompt(this.ai, {
			settings: history.snapshot.settings,
			lorebook: history.snapshot.ai?.lorebook,
			messages,
			transactions: events
				.filter((e) => e.active)
				.map((e) => history.transactions.find((t) => t.id === e.id)!),
			memories,
			state: this.state,
			input: this.input
		});
		prompt.pop();
		return prompt;
	}
	private messages(prompt: AIMessage[], prefix: string): AIMessage[] {
		const messages: AIMessage[] = [
			...prompt,
			...this.transcript,
			...(prefix ? [{ role: 'assistant' as const, content: prefix }] : []),
			{
				role: 'system',
				content:
					'Current game state (authoritative structured facts):\n' + JSON.stringify(this.state)
			}
		];
		if (JSON.stringify(messages).length > this.ai.maxContextChars) {
			throw new Error('AI 컨텍스트 한도를 초과했어요. 프롬프트나 대화 범위를 조정해주세요.');
		}
		return messages;
	}
	private async generate(messages: AIMessage[]) {
		const { generate, signal, emit, connection } = this.options;
		for (let retry = 0; retry <= AI_LIMITS.retries; retry++) {
			let observed = false;
			try {
				return await generate(
					{ ...connection, tools: this.tools, maxTokens: this.ai.maxTokens, messages },
					signal,
					(event) => {
						observed = true;
						emit(event);
					}
				);
			} catch (error) {
				if (observed || retry === AI_LIMITS.retries || signal.aborted) {
					throw error;
				}
			}
		}
		throw aiError();
	}
	private async validate(text: string): Promise<AgentWorkspaceResult> {
		if (!text.trim()) {
			throw aiError('protocol');
		}
		const validated = await this.options.run(
			{
				...this.base,
				state: this.timeline.history.progress.state,
				action: { name: '$helia.ai', args: { input: this.input } },
				operation: { kind: 'validate', state: this.state }
			},
			{ signal: this.options.signal }
		);
		this.check();
		return {
			state: validated.state,
			text: this.ai.promptSettings.assistantPrefill + text,
			events: this.events,
			hooks: this.hooks
		};
	}
	private async executeCall(call: import('./protocol.js').ToolCall) {
		this.check();
		if (++this.calls > AI_LIMITS.calls) {
			throw aiError('limit');
		}
		const tool = this.tools.find((t) => t.name === call.name);
		if (!tool) {
			throw aiError('protocol');
		}
		const { emit, run, signal } = this.options;
		emit({ type: 'tool', name: call.name, status: 'running' });
		try {
			const before = this.state,
				args = parseGameState(call.arguments);
			const result = await run(
				{
					...this.base,
					state: this.state,
					action: { name: call.name, args },
					...(tool.kind === 'query'
						? { operation: { kind: 'query' as const, name: call.name, args } }
						: {})
				},
				{ signal }
			);
			this.check();
			if (tool.kind === 'action') {
				this.applyAction(result, {
					before,
					after: result.state,
					action: { name: call.name, args }
				});
			}
			this.transcript.push({
				role: 'tool',
				callId: call.id,
				content: JSON.stringify(
					tool.kind === 'query' ? (result.value ?? null) : { ok: true, state: this.state }
				)
			});
			emit({ type: 'tool', name: call.name, status: 'completed' });
		} catch (error) {
			emit({ type: 'tool', name: call.name, status: 'failed' });
			throw error;
		}
	}
	private applyAction(result: Awaited<ReturnType<ActionRunner>>, trigger: RuleTrigger) {
		this.state = result.state;
		this.events.push(...(result.events ?? []));
		for (const name of result.independentHooks ?? []) {
			this.hooks.push({ name, trigger });
		}
		if (this.events.length > 128 || this.hooks.length > 16) {
			throw aiError('limit');
		}
	}
	async execute(): Promise<AgentWorkspaceResult> {
		this.check();
		const catalog = await this.options.run(
			{
				...this.base,
				state: this.state,
				action: { name: 'ai.catalog', args: {} },
				operation: { kind: 'catalog' }
			},
			{ signal: this.options.signal }
		);
		this.tools = catalog.tools ?? [];
		const prompt = this.prompt();
		const { emit } = this.options;
		for (let round = 0; round < AI_LIMITS.rounds; round++) {
			this.check();
			const prefix = this.ai.promptSettings.assistantPrefill;
			const messages = this.messages(prompt, prefix);
			if (prefix) {
				emit({ type: 'text', text: prefix });
			}
			const output = await this.generate(messages);
			this.check();
			if (!output.calls.length) {
				return this.validate(output.text);
			}
			emit({ type: 'reset' });
			if (prefix || output.text) {
				emit({ type: 'progress', text: prefix + output.text });
			}
			this.transcript.push({
				role: 'assistant',
				content: output.text,
				calls: output.calls,
				...(output.native ? { native: output.native } : {})
			});
			for (const call of output.calls) {
				await this.executeCall(call);
			}
		}
		throw aiError('limit');
	}
}
