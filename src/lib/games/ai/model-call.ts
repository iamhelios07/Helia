import { credentialRecord } from '#lib/app/settings/credential-protocol.js';
import { PROVIDER_KINDS, type ProviderKind } from '#lib/app/settings/model.js';
import { parseObjectSchema, type ObjectSchema } from '#lib/games/state/schema.js';
import { parseStateValue, type StateValue } from '#lib/games/state/value.js';

import {
	aiError,
	AI_LIMITS,
	parseCalls,
	parseModelContent,
	type AIMessage,
	type ToolCall
} from './protocol.js';

export type ModelContent =
	| { type: 'text'; text: string }
	| { type: 'image' | 'audio' | 'video' | 'file'; mimeType: string; data: string };
/** Provider continuation data is opaque and only reusable with the same provider and model. */
export interface ModelContinuation {
	provider: ProviderKind;
	model: string;
	data: StateValue[];
}
export interface ModelMessage {
	role: AIMessage['role'];
	content: string | ModelContent[];
	toolCalls?: ToolCall[];
	toolCallId?: string;
	continuation?: ModelContinuation;
}
export interface ModelTool {
	name: string;
	description?: string;
	arguments: ObjectSchema;
}
export interface ModelCallOptions {
	model?: 'main' | 'auxiliary';
	messages: ModelMessage[];
	tools?: ModelTool[];
}
export interface ModelUsage {
	inputTokens: number;
	outputTokens: number;
}
export interface ModelResponse {
	content: ModelContent[];
	toolCalls: ToolCall[];
	continuation?: ModelContinuation;
	usage?: ModelUsage;
}

function continuation(value: unknown): ModelContinuation | undefined {
	if (value === undefined) {
		return;
	}
	const item = credentialRecord(value);
	if (
		!PROVIDER_KINDS.includes(item.provider as ProviderKind) ||
		typeof item.model !== 'string' ||
		!item.model ||
		item.model.length > 256 ||
		!Array.isArray(item.data) ||
		item.data.length > 65536
	) {
		throw aiError('protocol');
	}
	return {
		provider: item.provider as ProviderKind,
		model: item.model,
		data: item.data.map((part) => parseStateValue(part))
	};
}

function messageLinks(
	item: Record<string, unknown>
): Pick<ModelMessage, 'toolCallId' | 'toolCalls' | 'continuation'> {
	const links: Pick<ModelMessage, 'toolCallId' | 'toolCalls' | 'continuation'> = {};
	if (item.toolCallId !== undefined) {
		if (
			typeof item.toolCallId !== 'string' ||
			!item.toolCallId ||
			item.toolCallId.length > 256 ||
			item.role !== 'tool'
		) {
			throw aiError('protocol');
		}
		links.toolCallId = item.toolCallId;
	}
	if (item.toolCalls !== undefined) {
		links.toolCalls = parseCalls(item.toolCalls);
	}
	const saved = continuation(item.continuation);
	if (saved) {
		links.continuation = saved;
	}
	if ((links.toolCalls || saved) && item.role !== 'assistant') {
		throw aiError('protocol');
	}
	return links;
}
function parseMessage(value: unknown): ModelMessage {
	const item = credentialRecord(value);
	if (!['system', 'user', 'assistant', 'tool'].includes(String(item.role))) {
		throw aiError('protocol');
	}
	const content = typeof item.content === 'string' ? item.content : parseModelContent(item.content);
	if (
		item.role === 'system' &&
		typeof content !== 'string' &&
		content.some((part) => part.type !== 'text')
	) {
		throw aiError('protocol');
	}
	const links = messageLinks(item);
	if (item.role === 'tool' && (typeof content !== 'string' || !links.toolCallId)) {
		throw aiError('protocol');
	}
	return { role: item.role as ModelMessage['role'], content, ...links };
}

function parseTools(value: unknown): ModelTool[] {
	if (!Array.isArray(value) || value.length > 256) {
		throw aiError('protocol');
	}
	const tools = value.map((value) => {
		const tool = credentialRecord(value);
		if (
			typeof tool.name !== 'string' ||
			!/^[a-zA-Z_][\w-]{0,63}$/.test(tool.name) ||
			(tool.description !== undefined &&
				(typeof tool.description !== 'string' || tool.description.length > 1024))
		) {
			throw aiError('protocol');
		}
		return {
			name: tool.name,
			description: tool.description as string | undefined,
			arguments: parseObjectSchema(tool.arguments)
		};
	});
	if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
		throw aiError('protocol');
	}
	return tools;
}

export function parseModelCall(value: unknown): ModelCallOptions {
	const item = credentialRecord(value);
	if (
		new TextEncoder().encode(JSON.stringify(value)).length > AI_LIMITS.wireBytes ||
		Object.keys(item).some((key) => !['model', 'messages', 'tools'].includes(key)) ||
		(item.model !== undefined && !['main', 'auxiliary'].includes(String(item.model))) ||
		!Array.isArray(item.messages) ||
		!item.messages.length ||
		item.messages.length > 512
	) {
		throw aiError('protocol');
	}
	const messages = item.messages.map(parseMessage);
	validateConversation(messages);
	return {
		model: (item.model ?? 'main') as 'main' | 'auxiliary',
		messages,
		tools: parseTools(item.tools ?? [])
	};
}

function addToolCalls(calls: ToolCall[], used: Set<string>, pending: Set<string>) {
	for (const call of calls) {
		if (used.has(call.id)) {
			throw aiError('protocol');
		}
		used.add(call.id);
		pending.add(call.id);
	}
}

function validateConversation(messages: ModelMessage[]) {
	const pending = new Set<string>();
	const used = new Set<string>();
	for (const message of messages) {
		if (message.role === 'tool') {
			if (!pending.delete(message.toolCallId!)) {
				throw aiError('protocol');
			}
			continue;
		}
		if (pending.size) {
			throw aiError('protocol');
		}
		addToolCalls(message.toolCalls ?? [], used, pending);
	}
	if (pending.size) {
		throw aiError('protocol');
	}
}

export function modelMessages(
	messages: ModelMessage[],
	provider: ProviderKind,
	model: string
): AIMessage[] {
	return messages.map((message) => {
		const saved = message.continuation;
		if (saved && (saved.provider !== provider || saved.model !== model)) {
			throw aiError('protocol');
		}
		return {
			role: message.role,
			content:
				typeof message.content === 'string'
					? message.content
					: message.content
							.filter((p) => p.type === 'text')
							.map((p) => p.text)
							.join(''),
			...(typeof message.content === 'string' ? {} : { parts: message.content }),
			...(message.toolCalls?.length ? { calls: message.toolCalls } : {}),
			...(message.toolCallId ? { callId: message.toolCallId } : {}),
			...(saved ? { native: saved.data } : {})
		};
	});
}
