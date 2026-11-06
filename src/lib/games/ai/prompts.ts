import { credentialRecord } from '#lib/app/settings/credential-protocol.js';
import type { GameSettings, Message } from '#lib/games/model.js';
import type { Memory, Transaction } from '#lib/games/state/model.js';
import type { GameState } from '#lib/games/state/value.js';
import { aiError, type AIMessage } from './protocol.js';

export const PROMPT_TYPES = [
	'plain',
	'jailbreak',
	'cot',
	'persona',
	'description',
	'lorebook',
	'postEverything',
	'memory',
	'authornote',
	'chat',
	'chatML',
	'cache'
] as const;
export type PromptType = (typeof PROMPT_TYPES)[number];
export type PromptRole = 'system' | 'user' | 'bot';
export interface PromptBlock {
	type: PromptType;
	type2?: 'normal' | 'globalNote' | 'main';
	role?: PromptRole | 'assistant' | 'all';
	text?: string;
	name?: string;
	innerFormat?: string;
	defaultText?: string;
	rangeStart?: number;
	rangeEnd?: number | 'end';
	chatAsOriginalOnSystem?: boolean;
	depth?: number;
	enabled?: boolean;
}
export interface LoreEntry {
	keys: string[];
	content: string;
	always?: boolean;
	enabled?: boolean;
	caseSensitive?: boolean;
}
/** Player-owned configuration; never persisted with game content or history. */
export interface PromptConfig {
	version: 2;
	promptTemplate: PromptBlock[];
	maxTokens: number;
	maxContextChars: number;
	jailbreakEnabled: boolean;
	cotEnabled: boolean;
	promptSettings: {
		sendChatAsSystem: boolean;
		postEndInnerFormat: string;
		assistantPrefill: string;
	};
}
/** Creator-owned AI context, safe to include in a game content snapshot. */
export interface GameAIContent {
	version: 1;
	lorebook: LoreEntry[];
}
function text(value: unknown, fallback = ''): string {
	if (value === undefined) return fallback;
	if (typeof value !== 'string' || value.length > 512 * 1024) throw aiError('protocol');
	return value;
}
function bool(value: unknown, fallback = false): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== 'boolean') throw aiError('protocol');
	return value;
}
function promptRole(value: unknown, cache = false): PromptBlock['role'] {
	if (value === undefined) return undefined;
	const role = value === 'assistant' ? 'bot' : value;
	if (role !== 'user' && role !== 'bot' && role !== 'system' && !(cache && role === 'all'))
		throw aiError('protocol');
	return role;
}
const defaultTemplate: PromptBlock[] = [
	{ type: 'plain', type2: 'main', role: 'system', text: '' },
	{ type: 'description' },
	{ type: 'persona' },
	{ type: 'lorebook' },
	{ type: 'memory' },
	{ type: 'chat', rangeStart: 0, rangeEnd: 'end' },
	{ type: 'authornote' },
	{ type: 'postEverything' }
];
export function parsePromptConfig(value: unknown): PromptConfig {
	const row = value === undefined ? {} : credentialRecord(value);
	if (row.version !== undefined && row.version !== 1 && row.version !== 2)
		throw aiError('protocol');
	const template = row.promptTemplate ?? defaultTemplate;
	if (!Array.isArray(template) || template.length > 128) throw aiError('protocol');
	const promptTemplate = template.map((value): PromptBlock => {
		const item = credentialRecord(value);
		if (!PROMPT_TYPES.includes(item.type as PromptType)) throw aiError('protocol');
		const block: PromptBlock = { type: item.type as PromptType };
		for (const key of ['text', 'name', 'innerFormat', 'defaultText'] as const)
			if (item[key] !== undefined) block[key] = text(item[key]);
		if (item.type2 !== undefined) {
			if (!['normal', 'globalNote', 'main'].includes(String(item.type2))) throw aiError('protocol');
			block.type2 = item.type2 as PromptBlock['type2'];
		}
		const role = promptRole(item.role, block.type === 'cache');
		// Read legacy Helia's effective role once, then retain only one canonical field.
		const legacyRole = promptRole(item.role2);
		const effectiveRole = block.type === 'cache' && role === 'all' ? role : (legacyRole ?? role);
		if (effectiveRole !== undefined) block.role = effectiveRole;
		for (const key of ['rangeStart', 'depth'] as const)
			if (item[key] !== undefined) {
				if (!Number.isInteger(item[key]) || Math.abs(Number(item[key])) > 100000)
					throw aiError('protocol');
				block[key] = Number(item[key]);
			}
		if (item.rangeEnd !== undefined) {
			if (item.rangeEnd !== 'end' && !Number.isInteger(item.rangeEnd)) throw aiError('protocol');
			block.rangeEnd = item.rangeEnd as number | 'end';
		}
		for (const key of ['enabled', 'chatAsOriginalOnSystem'] as const)
			if (item[key] !== undefined) block[key] = bool(item[key]);
		return block;
	});
	if (row.version !== 2) {
		// Legacy presets shared these values between blocks. Preserve each block's
		// effective body before dropping the shared fields from canonical config.
		for (const key of ['mainPrompt', 'globalNote', 'persona', 'postEverything'] as const) {
			const body = text(row[key]);
			if (!body) continue;
			const matches = promptTemplate.filter((block) =>
				key === 'mainPrompt' || key === 'globalNote'
					? ['plain', 'jailbreak', 'cot'].includes(block.type) &&
						block.type2 === (key === 'mainPrompt' ? 'main' : 'globalNote')
					: block.type === key
			);
			for (const block of matches) block.text = body;
			if (!matches.length) {
				// Unreferenced text was not sent previously. Retain it as an inactive
				// block so migration does not silently lose text or add instructions.
				if (promptTemplate.length >= 128)
					throw new Error('기존 프롬프트 본문을 보존하려면 블록 수를 128개 미만으로 줄여주세요.');
				promptTemplate.push({
					...(key === 'mainPrompt' || key === 'globalNote'
						? {
								type: 'plain' as const,
								type2: key === 'mainPrompt' ? ('main' as const) : ('globalNote' as const)
							}
						: { type: key }),
					text: body,
					enabled: false
				});
			}
		}
	}
	if (
		(row.maxTokens !== undefined && typeof row.maxTokens !== 'number') ||
		(row.maxContextChars !== undefined && typeof row.maxContextChars !== 'number')
	)
		throw aiError('protocol');
	const maxTokens = Number(row.maxTokens ?? 4096),
		maxContextChars = Number(row.maxContextChars ?? 200000);
	if (
		!Number.isInteger(maxTokens) ||
		maxTokens < 1 ||
		maxTokens > 65536 ||
		!Number.isInteger(maxContextChars) ||
		maxContextChars < 1024 ||
		maxContextChars > 2 * 1024 * 1024
	)
		throw aiError('protocol');
	const settings = row.promptSettings === undefined ? {} : credentialRecord(row.promptSettings);
	return {
		version: 2,
		promptTemplate,
		maxTokens,
		maxContextChars,
		jailbreakEnabled: bool(row.jailbreakEnabled, true),
		cotEnabled: bool(row.cotEnabled, true),
		promptSettings: {
			sendChatAsSystem: bool(settings.sendChatAsSystem),
			postEndInnerFormat: text(settings.postEndInnerFormat),
			assistantPrefill: text(settings.assistantPrefill)
		}
	};
}
/** Rebuild only game-owned fields, dropping legacy embedded user presets. */
export function parseGameAIContent(value: unknown): GameAIContent {
	const row = value === undefined ? {} : credentialRecord(value);
	if (row.version !== undefined && row.version !== 1) throw aiError('protocol');
	const lorebook = row.lorebook ?? [];
	if (!Array.isArray(lorebook) || lorebook.length > 1024) throw aiError('protocol');
	return {
		version: 1,
		lorebook: lorebook.map((value) => {
			const item = credentialRecord(value);
			if (!Array.isArray(item.keys) || item.keys.length > 128) throw aiError('protocol');
			return {
				keys: item.keys.map((k) => text(k)),
				content: text(item.content),
				always: bool(item.always),
				enabled: bool(item.enabled, true),
				caseSensitive: bool(item.caseSensitive)
			};
		})
	};
}
/** Import the JSON prompt portion of a Risu preset without importing credentials or CBS execution. */
export function importPromptPreset(value: unknown): PromptConfig {
	const row = credentialRecord(value);
	const heliaConfig = row.version === 1 || row.version === 2;
	const template = row.promptTemplate;
	const promptTemplate =
		!heliaConfig && Array.isArray(template)
			? template.map((value) => {
					const item = credentialRecord(value);
					const block = { ...item };
					// Risu uses different field names by block kind. A leftover field from
					// another kind must not override the role that Risu actually uses.
					const role = ['plain', 'jailbreak', 'cot', 'cache'].includes(String(item.type))
						? item.role
						: [
									'persona',
									'description',
									'lorebook',
									'postEverything',
									'memory',
									'authornote'
							  ].includes(String(item.type))
							? item.role2
							: undefined;
					delete block.role;
					delete block.role2;
					if (role !== undefined) block.role = role;
					return block;
				})
			: template;
	return parsePromptConfig({
		...row,
		promptTemplate,
		version: row.version === 2 ? 2 : 1,
		maxTokens: row.maxTokens ?? row.maxResponse,
		jailbreakEnabled: row.jailbreakEnabled ?? row.jailbreakToggle,
		cotEnabled: row.cotEnabled ?? row.chainOfThought
	});
}
export interface PromptContext {
	settings: GameSettings;
	lorebook?: LoreEntry[];
	messages: Message[];
	transactions: Transaction[];
	memories: Memory[];
	state: GameState;
	input?: string;
}
export function assemblePrompt(ai: PromptConfig, context: PromptContext): AIMessage[] {
	const result: AIMessage[] = [];
	const chat: AIMessage[] = context.messages.map((message) => ({
		role: message.role,
		content: message.content
	}));
	if (context.input) chat.push({ role: 'user', content: context.input });
	const haystack = chat.map((m) => m.content).join('\n');
	const lore = (context.lorebook ?? [])
		.filter(
			(e) =>
				e.enabled !== false &&
				(e.always ||
					e.keys.some(
						(key) =>
							key &&
							(e.caseSensitive
								? haystack.includes(key)
								: haystack.toLocaleLowerCase().includes(key.toLocaleLowerCase()))
					))
		)
		.map((e) => e.content)
		.join('\n\n');
	const slots = {
		description: context.settings.description,
		lorebook: lore,
		memory: context.memories.map((m) => m.content).join('\n'),
		authornote: context.settings.authorNote
	};
	const add = (role: AIMessage['role'], content: string) => {
		if (content.trim()) result.push({ role, content });
	};
	for (const block of ai.promptTemplate) {
		if (block.enabled === false) continue;
		const role = block.role ?? 'system';
		const normalizedRole =
			role === 'bot' || role === 'assistant' ? 'assistant' : role === 'user' ? 'user' : 'system';
		if (['plain', 'jailbreak', 'cot'].includes(block.type)) {
			if (
				(block.type === 'jailbreak' && !ai.jailbreakEnabled) ||
				(block.type === 'cot' && !ai.cotEnabled)
			)
				continue;
			add(normalizedRole, block.text ?? '');
		} else if (block.type === 'chat') {
			const end =
				block.rangeEnd === 'end' || block.rangeEnd === undefined ? undefined : block.rangeEnd;
			for (const message of chat.slice(block.rangeStart ?? 0, end))
				add(
					ai.promptSettings.sendChatAsSystem && !block.chatAsOriginalOnSystem
						? 'system'
						: message.role,
					message.content
				);
		} else if (block.type === 'chatML') {
			const pattern = /<\|im_start\|>(system|user|assistant|bot)\s*\n([\s\S]*?)<\|im_end\|>/g;
			const matches = [...(block.text ?? '').matchAll(pattern)];
			if (!matches.length && block.text?.trim())
				throw new Error('ChatML 프롬프트 형식을 확인해주세요.');
			for (const match of matches)
				add(match[1] === 'bot' ? 'assistant' : (match[1] as AIMessage['role']), match[2]);
		} else if (block.type === 'cache') {
			let remaining = block.depth ?? 1;
			for (let index = result.length - 1; index >= 0 && remaining > 0; index--) {
				const message = result[index];
				if (block.role === 'all' || message.role === normalizedRole) {
					message.cache = true;
					remaining--;
				}
			}
		} else {
			const value =
				block.type === 'persona' || block.type === 'postEverything'
					? (block.text ?? '')
					: slots[block.type as keyof typeof slots] ||
						(block.type === 'authornote' ? (block.defaultText ?? '') : '');
			if (value)
				add(
					normalizedRole,
					block.innerFormat === undefined ? value : block.innerFormat.replaceAll('{{slot}}', value)
				);
			if (block.type === 'postEverything') add('system', ai.promptSettings.postEndInnerFormat);
		}
	}
	if (context.transactions.length)
		add(
			'system',
			`Committed game transactions:\n${JSON.stringify(context.transactions.map((t) => ({ action: t.action, changes: t.changes, description: t.description })))}`
		);
	add(
		'system',
		`Current game state (authoritative structured facts):\n${JSON.stringify(context.state)}`
	);
	if (result.reduce((sum, m) => sum + m.content.length, 0) > ai.maxContextChars)
		throw new Error('AI 컨텍스트 한도를 초과했어요. 프롬프트나 대화 범위를 조정해주세요.');
	return result;
}
