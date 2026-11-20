import type { ProviderKind } from '#lib/app/settings/model.js';
import type { StateValue } from '#lib/games/state/value.js';

import type { ModelContent, ModelUsage } from './model-call.js';

import { aiError } from './protocol.js';

type Row = Record<string, unknown>;
const row = (value: unknown): Row =>
	value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Encode only documented inline media formats; unsupported combinations fail before any request. */
export function encodeModelContent(
	parts: ModelContent[],
	kind: ProviderKind,
	assistant = false
): unknown[] {
	return parts.map((part) => {
		if (kind === 'google' || kind === 'google-vertex') {
			return part.type === 'text'
				? { text: part.text }
				: { inlineData: { mimeType: part.mimeType, data: part.data } };
		}
		if (kind === 'google-interactions') {
			return part.type === 'text'
				? part
				: {
						type: part.type === 'file' ? 'document' : part.type,
						mime_type: part.mimeType,
						data: part.data
					};
		}
		if (kind === 'anthropic') {
			return anthropicPart(part);
		}
		if (kind === 'openai-responses') {
			return responsesPart(part, assistant);
		}
		return chatPart(part);
	});
}
function anthropicPart(part: ModelContent) {
	if (part.type === 'text') {
		return part;
	}
	if (part.type !== 'image' && !(part.type === 'file' && part.mimeType === 'application/pdf')) {
		throw aiError('protocol');
	}
	return {
		type: part.type === 'image' ? 'image' : 'document',
		source: { type: 'base64', media_type: part.mimeType, data: part.data }
	};
}
function responsesPart(part: ModelContent, assistant: boolean) {
	if (part.type === 'text') {
		return { type: assistant ? 'output_text' : 'input_text', text: part.text };
	}
	if (assistant) {
		throw aiError('protocol');
	}
	if (part.type === 'image') {
		return { type: 'input_image', image_url: `data:${part.mimeType};base64,${part.data}` };
	}
	if (part.type === 'file' && part.mimeType === 'application/pdf') {
		return {
			type: 'input_file',
			filename: 'document.pdf',
			file_data: `data:${part.mimeType};base64,${part.data}`
		};
	}
	throw aiError('protocol');
}
function chatPart(part: ModelContent) {
	if (part.type === 'text') {
		return part;
	}
	if (part.type === 'image') {
		return { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } };
	}
	if (part.type === 'audio' && ['audio/wav', 'audio/mpeg'].includes(part.mimeType)) {
		return {
			type: 'input_audio',
			input_audio: { data: part.data, format: part.mimeType === 'audio/wav' ? 'wav' : 'mp3' }
		};
	}
	throw aiError('protocol');
}

function mediaPart(value: Row): ModelContent | undefined {
	const inline = row(value.inlineData ?? value.inline_data);
	const source = row(value.source);
	const mime =
		inline.mimeType ?? inline.mime_type ?? value.mime_type ?? value.mimeType ?? source.media_type;
	const data = inline.data ?? value.data ?? source.data;
	if (typeof mime !== 'string' || typeof data !== 'string') {
		return;
	}
	const type = mime.split('/', 1)[0];
	return {
		type: ['image', 'audio', 'video'].includes(type)
			? (type as 'image' | 'audio' | 'video')
			: 'file',
		mimeType: mime,
		data
	};
}
function decodePart(value: unknown): ModelContent[] {
	const part = row(value);
	if (
		part.thought === true ||
		['thinking', 'reasoning', 'thought', 'redacted_thinking'].includes(String(part.type))
	) {
		return [];
	}
	if (typeof part.text === 'string') {
		return [{ type: 'text', text: part.text }];
	}
	const media = mediaPart(part);
	if (media) {
		return [media];
	}
	return list(part.content).flatMap(decodePart);
}

export function decodeModelContent(
	native: StateValue[],
	text: string,
	kind: ProviderKind
): ModelContent[] {
	if (kind === 'openai-compatible') {
		const message = row(native[0]);
		const parts = list(message.content).flatMap(decodePart);
		if (parts.length) {
			return parts;
		}
		return text ? [{ type: 'text', text }] : [];
	}
	const parts = native.flatMap(decodePart);
	if (parts.length) {
		return parts;
	}
	return text ? [{ type: 'text', text }] : [];
}

export function modelUsage(value: unknown, previous?: ModelUsage): ModelUsage | undefined {
	const event = row(value);
	const nested = row(event.response ?? event.message ?? event.interaction);
	const usage = row(event.usage ?? event.usageMetadata ?? event.usage_metadata ?? nested.usage);
	const input =
		usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokenCount ?? usage.total_input_tokens;
	const output =
		usage.output_tokens ??
		usage.completion_tokens ??
		usage.candidatesTokenCount ??
		usage.total_output_tokens;
	if (input === undefined && output === undefined) {
		return previous;
	}
	const count = (value: unknown, fallback: number) =>
		typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
	return {
		inputTokens: count(input, previous?.inputTokens ?? 0),
		outputTokens: count(output, previous?.outputTokens ?? 0)
	};
}
