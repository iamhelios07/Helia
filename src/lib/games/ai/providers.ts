import { credentialRecord } from '#lib/app/settings/credential-protocol.js';
import { parseStateValue, type StateValue } from '#lib/games/state/value.js';
import {
	aiError,
	AI_LIMITS,
	parseCalls,
	type AIMessage,
	type AgentEvent,
	type ModelRound,
	type RoundRequest,
	type ToolCall
} from './protocol.js';

type Row = Record<string, unknown>;
const row = (value: unknown): Row => credentialRecord(value);
const list = (value: unknown): unknown[] => {
	if (!Array.isArray(value)) throw aiError('protocol');
	return value;
};
const str = (value: unknown): string => {
	if (typeof value !== 'string') throw aiError('protocol');
	return value;
};
const optionalRow = (value: unknown): Row =>
	value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const json = (value: unknown) => JSON.stringify(value);
function parseJSON(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		throw aiError('protocol');
	}
}

/** Pure request encoding: no key or provider client enters creator code. */
export function encodeProviderRequest(request: RoundRequest): { path: string; body: Row } {
	const { provider, model, messages, tools, maxTokens } = request;
	const functions = tools.map((t) => ({
		name: t.name,
		description: t.description,
		parameters: t.arguments
	}));
	if (provider.kind === 'openai-compatible')
		return {
			path: '/chat/completions',
			body: {
				model,
				stream: true,
				max_tokens: maxTokens,
				messages: messages.map((m) => {
					if (m.role === 'tool')
						return { role: 'tool', tool_call_id: m.callId, content: m.content };
					if (m.role === 'assistant' && m.native?.[0]) return m.native[0];
					return {
						role: m.role,
						content: m.content,
						...(m.calls?.length
							? {
									tool_calls: m.calls.map((c) => ({
										id: c.id,
										type: 'function',
										function: { name: c.name, arguments: json(c.arguments) }
									}))
								}
							: {})
					};
				}),
				...(tools.length
					? {
							tools: functions.map((f) => ({ type: 'function', function: f })),
							tool_choice: 'auto'
						}
					: {})
			}
		};
	if (provider.kind === 'openai-responses')
		return {
			path: '/responses',
			body: {
				model,
				stream: true,
				store: false,
				include: ['reasoning.encrypted_content'],
				max_output_tokens: maxTokens,
				input: messages.flatMap<unknown>((m) => {
					if (m.role === 'tool')
						return [{ type: 'function_call_output', call_id: m.callId, output: m.content }];
					if (m.role === 'assistant' && m.native) return m.native;
					return [{ role: m.role, content: m.content }];
				}),
				...(tools.length
					? { tools: functions.map((f) => ({ type: 'function', ...f, strict: false })) }
					: {})
			}
		};
	if (provider.kind === 'anthropic')
		return {
			path: '/messages',
			body: {
				model,
				max_tokens: maxTokens,
				stream: true,
				system: messages
					.filter((m) => m.role === 'system')
					.map((m) => ({
						type: 'text',
						text: m.content,
						...(m.cache ? { cache_control: { type: 'ephemeral' } } : {})
					})),
				messages: mergeAnthropic(
					messages
						.filter((m) => m.role !== 'system')
						.map((m) => ({
							role: m.role === 'assistant' ? 'assistant' : 'user',
							content:
								m.role === 'tool'
									? [{ type: 'tool_result', tool_use_id: m.callId, content: m.content }]
									: (m.native ?? [
											{
												type: 'text',
												text: m.content,
												...(m.cache ? { cache_control: { type: 'ephemeral' } } : {})
											}
										])
						}))
				),
				...(tools.length
					? {
							tools: functions.map((f) => ({
								name: f.name,
								description: f.description,
								input_schema: f.parameters
							}))
						}
					: {})
			}
		};
	if (provider.kind === 'google' || provider.kind === 'google-vertex')
		return {
			path: `/models/${encodeURIComponent(model.replace(/^models\//, ''))}:streamGenerateContent?alt=sse`,
			body: {
				systemInstruction: {
					parts: messages.filter((m) => m.role === 'system').map((m) => ({ text: m.content }))
				},
				contents: messages
					.filter((m) => m.role !== 'system')
					.map((m) => ({
						role: m.role === 'assistant' ? 'model' : 'user',
						parts:
							m.role === 'tool'
								? [
										{
											functionResponse: {
												...googleCallId(messages, m.callId),
												name: toolName(messages, m.callId),
												response: { result: parseJSON(m.content) }
											}
										}
									]
								: (m.native ?? [{ text: m.content }])
					})),
				generationConfig: { maxOutputTokens: maxTokens },
				...(tools.length
					? {
							tools: [
								{
									functionDeclarations: functions.map((f) => ({
										name: f.name,
										description: f.description,
										parametersJsonSchema: f.parameters
									}))
								}
							]
						}
					: {})
			}
		};
	return {
		path: '/interactions',
		body: {
			model,
			stream: true,
			store: false,
			system_instruction: messages
				.filter((m) => m.role === 'system')
				.map((m) => m.content)
				.join('\n\n'),
			input: messages
				.filter((m) => m.role !== 'system')
				.flatMap<unknown>((m) => {
					if (m.role === 'tool')
						return [
							{
								type: 'function_result',
								call_id: m.callId,
								name: toolName(messages, m.callId),
								result: [{ type: 'text', text: m.content }]
							}
						];
					if (m.role === 'assistant' && m.native) return m.native;
					return [
						{
							type: m.role === 'assistant' ? 'model_output' : 'user_input',
							content: [{ type: 'text', text: m.content }]
						}
					];
				}),
			generation_config: { max_output_tokens: maxTokens },
			...(tools.length ? { tools: functions.map((f) => ({ type: 'function', ...f })) } : {})
		}
	};
}
function toolName(messages: AIMessage[], id?: string): string {
	const call = messages.flatMap((m) => m.calls ?? []).find((c) => c.id === id);
	if (!call) throw aiError('protocol');
	return call.name;
}
function googleCallId(messages: AIMessage[], id?: string): { id?: string } {
	const source = messages.find((message) => message.calls?.some((call) => call.id === id));
	const actual = source?.native
		?.map((value) => optionalRow(optionalRow(value).functionCall))
		.find((call) => call.id === id);
	return actual && typeof actual.id === 'string' ? { id: actual.id } : {};
}
function mergeAnthropic(messages: { role: string; content: unknown[] }[]) {
	const result: typeof messages = [];
	for (const message of messages) {
		const last = result.at(-1);
		if (last?.role === message.role) last.content.push(...message.content);
		else result.push({ ...message, content: [...message.content] });
	}
	return result;
}

/** Bounded SSE decoder shared by native and web transports. It never accepts an incomplete turn. */
export class ProviderDecoder {
	private buffer = '';
	private bytes = 0;
	private complete = false;
	private text = '';
	private reasoning = '';
	private calls = new Map<number, Row>();
	private native: StateValue[] = [];
	private stop = '';
	private done = false;
	constructor(
		private kind: RoundRequest['provider']['kind'],
		private emit: (event: AgentEvent) => void
	) {}
	push(chunk: string) {
		this.bytes += new TextEncoder().encode(chunk).length;
		if (this.bytes > AI_LIMITS.outputBytes) throw aiError('limit');
		this.buffer += chunk;
		this.buffer = this.buffer.replace(/\r\n/g, '\n');
		let end: number;
		while ((end = this.buffer.indexOf('\n\n')) !== -1) {
			const event = this.buffer.slice(0, end);
			this.buffer = this.buffer.slice(end + 2);
			const data = event
				.split('\n')
				.filter((l) => l.startsWith('data:'))
				.map((l) => l.slice(5).trimStart())
				.join('\n');
			if (!data) continue;
			if (data === '[DONE]') {
				this.done = true;
				continue;
			}
			let value: unknown;
			try {
				value = JSON.parse(data);
			} catch {
				throw aiError('protocol');
			}
			this.accept(row(value));
		}
	}
	private textDelta(value: unknown, thinking = false) {
		if (typeof value !== 'string' || !value) return;
		if (!thinking) this.text += value;
		else this.reasoning += value;
		this.emit({ type: thinking ? 'thinking' : 'text', text: value });
	}
	private accept(data: Row) {
		if (data.helia_nonstream) {
			this.acceptJSON(row(data.helia_nonstream));
			return;
		}
		if (data.error || data.type === 'error' || data.event_type === 'error') throw aiError();
		if (this.kind === 'openai-compatible') {
			const choice = optionalRow(list(data.choices)[0]);
			if (!Object.keys(choice).length) return;
			const delta = optionalRow(choice.delta);
			this.textDelta(delta.content);
			this.textDelta(delta.reasoning_content ?? delta.reasoning, true);
			if (delta.tool_calls)
				for (const value of list(delta.tool_calls)) {
					const call = row(value),
						index = Number(call.index);
					if (!Number.isInteger(index) || index < 0 || index > AI_LIMITS.calls)
						throw aiError('protocol');
					const current = this.calls.get(index) ?? { id: '', name: '', arguments: '' };
					const fn = optionalRow(call.function);
					current.id = String(current.id) + String(call.id ?? '');
					current.name = String(current.name) + String(fn.name ?? '');
					current.arguments = String(current.arguments) + String(fn.arguments ?? '');
					this.calls.set(index, current);
				}
			if (choice.finish_reason) {
				this.stop = str(choice.finish_reason);
				this.complete = ['stop', 'tool_calls'].includes(this.stop);
				if (!this.complete) throw aiError('protocol');
			}
		} else if (this.kind === 'openai-responses') {
			const type = String(data.type);
			if (type === 'response.output_text.delta') this.textDelta(data.delta);
			if (
				type === 'response.reasoning_summary_text.delta' ||
				type === 'response.reasoning_text.delta'
			)
				this.textDelta(data.delta, true);
			if (type === 'response.completed') {
				const response = row(data.response);
				if (response.status !== 'completed') throw aiError('protocol');
				this.native = list(response.output).map((value) => parseStateValue(value));
				this.complete = true;
				for (const item of this.native) {
					const block = optionalRow(item);
					if (block.type === 'function_call')
						this.calls.set(this.calls.size, {
							id: block.call_id,
							name: block.name,
							arguments: block.arguments
						});
				}
			}
			if (['response.failed', 'response.incomplete', 'response.error'].includes(type))
				throw aiError('protocol');
		} else if (this.kind === 'anthropic') {
			const type = String(data.type),
				index = Number(data.index ?? 0);
			if (type === 'content_block_start') {
				const block = row(data.content_block);
				this.calls.set(index, { ...block, _json: '' });
			}
			if (type === 'content_block_delta') {
				const delta = row(data.delta),
					block = this.calls.get(index);
				if (!block) throw aiError('protocol');
				if (delta.type === 'text_delta') {
					this.textDelta(delta.text);
					block.text = String(block.text ?? '') + str(delta.text);
				}
				if (delta.type === 'thinking_delta') {
					this.textDelta(delta.thinking, true);
					block.thinking = String(block.thinking ?? '') + str(delta.thinking);
				}
				if (delta.type === 'signature_delta')
					block.signature = String(block.signature ?? '') + str(delta.signature);
				if (delta.type === 'input_json_delta')
					block._json = String(block._json) + str(delta.partial_json);
			}
			if (type === 'message_delta' && row(data.delta).stop_reason) {
				this.stop = String(row(data.delta).stop_reason ?? '');
				if (!['end_turn', 'tool_use', 'stop_sequence'].includes(this.stop))
					throw aiError('protocol');
			}
			if (type === 'message_stop') this.complete = !!this.stop;
		} else if (this.kind === 'google' || this.kind === 'google-vertex') {
			if (data.promptFeedback && row(data.promptFeedback).blockReason) throw aiError('protocol');
			const candidate = optionalRow(list(data.candidates ?? [])[0]);
			if (!Object.keys(candidate).length) return;
			const content = optionalRow(candidate.content);
			for (const value of list(content.parts ?? [])) {
				const part = row(value);
				this.native.push(parseStateValue(part));
				if (part.text) this.textDelta(part.text, part.thought === true);
				if (part.functionCall) {
					const fn = row(part.functionCall);
					this.calls.set(this.calls.size, {
						id: fn.id ?? `google_${this.calls.size}`,
						name: fn.name,
						arguments: fn.args ?? {}
					});
				}
			}
			if (candidate.finishReason) {
				this.complete = candidate.finishReason === 'STOP';
				if (!this.complete) throw aiError('protocol');
			}
		} else {
			const type = String(data.event_type ?? data.type),
				index = Number(data.index ?? 0);
			if (type === 'step.start') {
				const step = row(data.step);
				this.calls.set(index, { ...step, _json: '' });
			}
			if (type === 'step.delta') {
				const delta = row(data.delta),
					step = this.calls.get(index);
				if (!step) throw aiError('protocol');
				if (delta.type === 'text') {
					const thought = step.type === 'thought';
					this.textDelta(delta.text, thought);
					step.content = [
						...(Array.isArray(step.content) ? step.content : []),
						{ type: 'text', text: delta.text }
					];
				}
				if (delta.type === 'arguments_delta')
					step._json = String(step._json) + str(delta.arguments);
				if (delta.type === 'thought_signature') step.signature = delta.signature;
			}
			if (
				type === 'interaction.status_update' &&
				['failed', 'cancelled', 'incomplete', 'budget_exceeded'].includes(String(data.status))
			)
				throw aiError('protocol');
			if (type === 'interaction.completed') {
				const interaction = optionalRow(data.interaction);
				if (
					interaction.status &&
					interaction.status !== 'completed' &&
					interaction.status !== 'requires_action'
				)
					throw aiError('protocol');
				if (Array.isArray(interaction.steps))
					this.native = interaction.steps.map((value) => parseStateValue(value));
				this.complete = true;
			}
		}
	}
	private acceptJSON(data: Row) {
		if (data.error) throw aiError();
		if (this.kind === 'openai-compatible') {
			const choice = row(list(data.choices)[0]),
				message = row(choice.message);
			if (!['stop', 'tool_calls'].includes(String(choice.finish_reason))) throw aiError('protocol');
			this.textDelta(message.content);
			this.textDelta(message.reasoning_content, true);
			this.native = [parseStateValue(message)];
			for (const value of list(message.tool_calls ?? [])) {
				const call = row(value),
					fn = row(call.function);
				this.calls.set(this.calls.size, { id: call.id, name: fn.name, arguments: fn.arguments });
			}
			this.complete = true;
			this.done = true;
		} else if (this.kind === 'openai-responses') {
			for (const value of list(data.output)) {
				const item = row(value);
				if (item.type === 'message')
					for (const part of list(item.content)) {
						const content = row(part);
						if (content.type === 'output_text') this.textDelta(content.text);
					}
			}
			this.accept({ type: 'response.completed', response: data });
		} else if (this.kind === 'anthropic') {
			if (!['end_turn', 'tool_use', 'stop_sequence'].includes(String(data.stop_reason)))
				throw aiError('protocol');
			for (const value of list(data.content)) {
				const block = row(value);
				this.calls.set(this.calls.size, { ...block, _json: '' });
				if (block.type === 'text') this.textDelta(block.text);
				if (block.type === 'thinking') this.textDelta(block.thinking, true);
			}
			this.complete = true;
		} else if (this.kind === 'google' || this.kind === 'google-vertex') this.accept(data);
		else {
			if (!['completed', 'requires_action'].includes(String(data.status)))
				throw aiError('protocol');
			this.native = list(data.steps ?? data.outputs).map((value) => parseStateValue(value));
			for (const value of this.native) {
				const item = row(value);
				if (item.type === 'model_output')
					for (const content of list(item.content ?? [])) {
						const part = row(content);
						if (part.type === 'text') this.textDelta(part.text);
					}
				else if (item.type === 'text') this.textDelta(item.text);
			}
			this.complete = true;
		}
	}
	finish(): ModelRound {
		if (this.buffer.trim()) this.push('\n\n');
		if (!this.complete || (this.kind === 'openai-compatible' && !this.done))
			throw aiError('protocol');
		let calls: ToolCall[];
		if (this.kind === 'anthropic') {
			this.native = [...this.calls.values()].map((block) => {
				const { _json, ...native } = block;
				if (native.type === 'tool_use')
					native.input = _json ? parseJSON(String(_json)) : (native.input ?? {});
				return parseStateValue(native);
			});
			calls = this.native
				.filter((value) => optionalRow(value).type === 'tool_use')
				.map((value) => {
					const b = row(value);
					return { id: str(b.id), name: str(b.name), arguments: parseStateValue(b.input) };
				});
		} else if (this.kind === 'google-interactions') {
			if (!this.native.length)
				this.native = [...this.calls.values()].map((step) => {
					const { _json, ...native } = step;
					if (native.type === 'function_call')
						native.arguments = _json ? parseJSON(String(_json)) : (native.arguments ?? {});
					return parseStateValue(native);
				});
			calls = this.native
				.filter((value) => optionalRow(value).type === 'function_call')
				.map((value) => {
					const b = row(value);
					return { id: str(b.id), name: str(b.name), arguments: parseStateValue(b.arguments) };
				});
		} else
			calls = [...this.calls.values()].map((c) => ({
				id: str(c.id),
				name: str(c.name),
				arguments: parseStateValue(
					typeof c.arguments === 'string' ? parseJSON(c.arguments) : c.arguments
				)
			}));
		calls = parseCalls(calls);
		if (this.kind === 'openai-compatible' && this.reasoning)
			this.native = [
				parseStateValue({
					role: 'assistant',
					content: this.text,
					reasoning_content: this.reasoning,
					...(calls.length
						? {
								tool_calls: calls.map((call) => ({
									id: call.id,
									type: 'function',
									function: { name: call.name, arguments: JSON.stringify(call.arguments) }
								}))
							}
						: {})
				})
			];
		if (calls.length === 0 && !this.text.trim()) throw aiError('protocol');
		return { text: this.text, calls, ...(this.native.length ? { native: this.native } : {}) };
	}
}
