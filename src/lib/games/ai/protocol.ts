import {
	providerAddress,
	credentialRecord,
	type ProviderAddress
} from '#lib/app/settings/credential-protocol.js';
import { parseObjectSchema, type ObjectSchema } from '#lib/games/state/schema.js';
import { parseStateValue, type StateValue } from '#lib/games/state/value.js';

export const AI_LIMITS = Object.freeze({
	rounds: 12,
	calls: 32,
	retries: 2,
	timeoutMs: 120_000,
	wireBytes: 4 * 1024 * 1024,
	outputBytes: 2 * 1024 * 1024
});
export type AgentEvent =
	| { type: 'error'; message: string }
	| { type: 'reset' }
	| { type: 'text'; text: string }
	| { type: 'thinking'; text: string }
	| { type: 'progress'; text: string }
	| { type: 'tool'; name: string; status: 'running' | 'completed' | 'failed' }
	| { type: 'status'; status: 'generating' | 'committing' | 'committed' };
export interface ToolDefinition {
	name: string;
	description: string;
	arguments: ObjectSchema;
	kind: 'action' | 'query';
}
export interface ToolCall {
	id: string;
	name: string;
	arguments: StateValue;
}
/** Provider-native continuation blocks stay outside persistent game content. */
export interface AIMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	callId?: string;
	calls?: ToolCall[];
	native?: StateValue[];
	cache?: boolean;
}
export interface RoundRequest {
	provider: ProviderAddress;
	model: string;
	messages: AIMessage[];
	tools: ToolDefinition[];
	maxTokens: number;
}
export interface ModelRound {
	text: string;
	calls: ToolCall[];
	native?: StateValue[];
}
export type ModelGenerator = (
	request: RoundRequest,
	signal: AbortSignal,
	emit: (event: AgentEvent) => void
) => Promise<ModelRound>;
export interface AgentOptions {
	signal?: AbortSignal;
	onEvent?: (event: AgentEvent) => void;
}
export function aiError(
	code: 'provider' | 'protocol' | 'limit' | 'canceled' | 'busy' | 'timeout' = 'provider'
): Error {
	const messages = {
		provider: 'AI 요청을 완료하지 못했어요. 연결과 모델 권한을 확인해주세요.',
		protocol: 'AI 응답 형식이 올바르지 않거나 응답이 중단되었어요.',
		limit: 'AI 실행 한도를 초과했어요.',
		canceled: 'AI 요청을 중단했어요.',
		busy: 'AI 응답 생성 중에는 게임 상태를 변경할 수 없어요.',
		timeout: 'AI 응답 대기 시간을 초과했어요.'
	};
	return new Error(messages[code]);
}
export function parseRoundRequest(value: unknown): RoundRequest {
	const row = credentialRecord(value);
	if (
		JSON.stringify(value).length > AI_LIMITS.wireBytes ||
		typeof row.model !== 'string' ||
		!row.model.trim() ||
		row.model.length > 256 ||
		!Array.isArray(row.messages) ||
		row.messages.length > 512 ||
		!Array.isArray(row.tools) ||
		row.tools.length > 256
	) {
		throw aiError('protocol');
	}
	const messages = row.messages.map((value): AIMessage => {
		const item = credentialRecord(value);
		if (
			!['system', 'user', 'assistant', 'tool'].includes(String(item.role)) ||
			typeof item.content !== 'string'
		) {
			throw aiError('protocol');
		}
		const calls = item.calls === undefined ? undefined : parseCalls(item.calls);
		if (
			item.callId !== undefined &&
			(typeof item.callId !== 'string' || item.callId.length > 256)
		) {
			throw aiError('protocol');
		}
		if (item.native !== undefined && !Array.isArray(item.native)) {
			throw aiError('protocol');
		}
		return {
			role: item.role as AIMessage['role'],
			content: item.content,
			...(calls ? { calls } : {}),
			...(typeof item.callId === 'string' ? { callId: item.callId } : {}),
			...(Array.isArray(item.native)
				? { native: item.native.map((value) => parseStateValue(value)) }
				: {}),
			...(item.cache === true ? { cache: true } : {})
		};
	});
	const tools = row.tools.map((value): ToolDefinition => {
		const item = credentialRecord(value);
		if (
			typeof item.name !== 'string' ||
			!/^[a-zA-Z_][\w-]{0,63}$/.test(item.name) ||
			typeof item.description !== 'string' ||
			item.description.length > 1024 ||
			!['action', 'query'].includes(String(item.kind))
		) {
			throw aiError('protocol');
		}
		return {
			name: item.name,
			description: item.description,
			kind: item.kind as ToolDefinition['kind'],
			arguments: parseObjectSchema(item.arguments)
		};
	});
	if (new Set(tools.map((t) => t.name)).size !== tools.length) {
		throw aiError('protocol');
	}
	if (
		!Number.isInteger(row.maxTokens) ||
		Number(row.maxTokens) < 1 ||
		Number(row.maxTokens) > 65536
	) {
		throw aiError('protocol');
	}
	return {
		provider: providerAddress(row.provider),
		model: row.model,
		messages,
		tools,
		maxTokens: Number(row.maxTokens)
	};
}
export function parseCalls(value: unknown): ToolCall[] {
	if (!Array.isArray(value) || value.length > AI_LIMITS.calls) {
		throw aiError('protocol');
	}
	const calls = value.map((value): ToolCall => {
		const row = credentialRecord(value);
		if (
			typeof row.id !== 'string' ||
			!row.id ||
			row.id.length > 256 ||
			typeof row.name !== 'string' ||
			!/^[a-zA-Z_][\w-]{0,63}$/.test(row.name)
		) {
			throw aiError('protocol');
		}
		return { id: row.id, name: row.name, arguments: parseStateValue(row.arguments) };
	});
	if (new Set(calls.map((call) => call.id)).size !== calls.length) {
		throw aiError('protocol');
	}
	return calls;
}
