import type { GameSettings, Message } from '#lib/games/model.js';
import type { Memory, Transaction } from '#lib/games/state/model.js';
import type { GameState } from '#lib/games/state/value.js';

import { credentialRecord } from '#lib/app/settings/credential-protocol.js';

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
	/** Stable identifier used by the editor; generated from position when absent. */
	id?: string;
	/** Creator-facing title shown in the lorebook editor; defaults to the entry number. */
	name?: string;
	/** Logical folder name; entries without one sit at the top level. */
	folder?: string;
	/** Trigger keywords; any hit activates the entry unless it is always-on. */
	keys: string[];
	content: string;
	/** Sort weight inside the assembled prompt; higher numbers come first. */
	order?: number;
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
	/** Folder names that exist even without entries; empty folders persist here. */
	folders?: string[];
}
function text(value: unknown, fallback = ''): string {
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== 'string' || value.length > 512 * 1024) {
		throw aiError('protocol');
	}
	return value;
}
function bool(value: unknown, fallback = false): boolean {
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== 'boolean') {
		throw aiError('protocol');
	}
	return value;
}
function promptRole(value: unknown, cache = false): PromptBlock['role'] {
	if (value === undefined) {
		return undefined;
	}
	const role = value === 'assistant' ? 'bot' : value;
	if (role !== 'user' && role !== 'bot' && role !== 'system' && !(cache && role === 'all')) {
		throw aiError('protocol');
	}
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
function parsePromptBlock(value: unknown): PromptBlock {
	const item = credentialRecord(value);
	if (!PROMPT_TYPES.includes(item.type as PromptType)) {
		throw aiError('protocol');
	}
	const block: PromptBlock = { type: item.type as PromptType };
	for (const key of ['text', 'name', 'innerFormat', 'defaultText'] as const) {
		if (item[key] !== undefined) {
			block[key] = text(item[key]);
		}
	}
	if (item.type2 !== undefined) {
		block.type2 = promptSpecialType(item.type2);
	}
	const role = promptRole(item.role, block.type === 'cache');
	// Read legacy Helia's effective role once, then retain only one canonical field.
	const legacyRole = promptRole(item.role2);
	const effectiveRole = block.type === 'cache' && role === 'all' ? role : (legacyRole ?? role);
	if (effectiveRole !== undefined) {
		block.role = effectiveRole;
	}
	parsePromptRanges(item, block);
	for (const key of ['enabled', 'chatAsOriginalOnSystem'] as const) {
		if (item[key] !== undefined) {
			block[key] = bool(item[key]);
		}
	}
	return block;
}
function migrateLegacyPrompt(row: Record<string, unknown>, promptTemplate: PromptBlock[]) {
	// Legacy presets shared these values between blocks. Preserve each block's
	// effective body before dropping the shared fields from canonical config.
	for (const key of ['mainPrompt', 'globalNote', 'persona', 'postEverything'] as const) {
		const body = text(row[key]);
		if (!body) {
			continue;
		}
		const matches = promptTemplate.filter((block) => matchesLegacyPrompt(block, key));
		for (const block of matches) {
			block.text = body;
		}
		if (!matches.length) {
			// Unreferenced text was not sent previously. Retain it as an inactive
			// block so migration does not silently lose text or add instructions.
			if (promptTemplate.length >= 128) {
				throw new Error('기존 프롬프트 본문을 보존하려면 블록 수를 128개 미만으로 줄여주세요.');
			}
			promptTemplate.push(inactiveLegacyPrompt(key, body));
		}
	}
}
export function parsePromptConfig(value: unknown): PromptConfig {
	const row = value === undefined ? {} : credentialRecord(value);
	if (row.version !== undefined && row.version !== 1 && row.version !== 2) {
		throw aiError('protocol');
	}
	const template = row.promptTemplate ?? defaultTemplate;
	if (!Array.isArray(template) || template.length > 128) {
		throw aiError('protocol');
	}
	const promptTemplate = template.map(parsePromptBlock);
	if (row.version !== 2) {
		migrateLegacyPrompt(row, promptTemplate);
	}
	if (
		(row.maxTokens !== undefined && typeof row.maxTokens !== 'number') ||
		(row.maxContextChars !== undefined && typeof row.maxContextChars !== 'number')
	) {
		throw aiError('protocol');
	}
	const maxTokens = Number(row.maxTokens ?? 4096),
		maxContextChars = Number(row.maxContextChars ?? 200000);
	if (
		!Number.isInteger(maxTokens) ||
		maxTokens < 1 ||
		maxTokens > 65536 ||
		!Number.isInteger(maxContextChars) ||
		maxContextChars < 1024 ||
		maxContextChars > 2 * 1024 * 1024
	) {
		throw aiError('protocol');
	}
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
	if (row.version !== undefined && row.version !== 1) {
		throw aiError('protocol');
	}
	const lorebook = row.lorebook ?? [];
	if (!Array.isArray(lorebook) || lorebook.length > 1024) {
		throw aiError('protocol');
	}
	const foldersRow = row.folders === undefined ? undefined : parseLoreFolders(row.folders);
	return {
		version: 1,
		lorebook: lorebook.map((value, index) => parseLoreEntry(value, index)),
		...(foldersRow === undefined ? {} : { folders: foldersRow })
	};
}
/** Folder names: 1-80 chars, unique, at most 128. */
function parseLoreFolders(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 128) {
		throw aiError('protocol');
	}
	const names = value.map((name) => text(name).trim());
	const unique = [...new Set(names)];
	if (unique.some((name) => !name || name.length > 80)) {
		throw aiError('protocol');
	}
	return unique;
}

/**
 * Parses one lorebook entry. Legacy entries (keys/content/always only) gain a generated
 * id, their position as the sort order and an entry-count-based name.
 */
export function parseLoreEntry(value: unknown, index: number): LoreEntry {
	const item = credentialRecord(value);
	if (!Array.isArray(item.keys) || item.keys.length > 128) {
		throw aiError('protocol');
	}
	const order = item.order === undefined ? index : counter2(item.order);
	const name =
		item.name === undefined ? '로어 ' + (index + 1) : text(item.name, '로어 ' + (index + 1));
	return {
		id: item.id === undefined ? 'lore-' + (index + 1) : text(item.id),
		name,
		...(item.folder === undefined ? {} : { folder: text(item.folder, '') }),
		keys: item.keys.map((k) => text(k)),
		content: text(item.content),
		order,
		always: bool(item.always),
		enabled: bool(item.enabled, true),
		caseSensitive: bool(item.caseSensitive)
	};
}
function counter2(value: unknown): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1e6) {
		throw aiError('protocol');
	}
	return value;
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
					const role = importedPromptRole(item);
					delete block.role;
					delete block.role2;
					if (role !== undefined) {
						block.role = role;
					}
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

function normalizedRole(role: PromptBlock['role']): AIMessage['role'] {
	if (role === 'bot' || role === 'assistant') {
		return 'assistant';
	}
	return role === 'user' ? 'user' : 'system';
}
/** Sorts by the creator's order weight (higher first), falling back to list position. */
function orderedLore(lorebook: LoreEntry[]): LoreEntry[] {
	return lorebook
		.map((entry, index) => ({ entry, index }))
		.sort((a, b) => (b.entry.order ?? 0) - (a.entry.order ?? 0) || a.index - b.index)
		.map((row) => row.entry);
}
function matchesLore(entry: LoreEntry, haystack: string): boolean {
	if (entry.enabled === false) {
		return false;
	}
	return !!(
		entry.always ||
		entry.keys.some(
			(key) =>
				key &&
				(entry.caseSensitive
					? haystack.includes(key)
					: haystack.toLocaleLowerCase().includes(key.toLocaleLowerCase()))
		)
	);
}
export function assemblePrompt(ai: PromptConfig, context: PromptContext): AIMessage[] {
	return new PromptAssembler(ai, context).assemble();
}
class PromptAssembler {
	private result: AIMessage[] = [];
	private chat: AIMessage[];
	private slots: Record<string, string>;
	constructor(
		private ai: PromptConfig,
		private context: PromptContext
	) {
		this.chat = context.messages.map((message) => ({
			role: message.role,
			content: message.content
		}));
		if (context.input) {
			this.chat.push({ role: 'user', content: context.input });
		}
		const haystack = this.chat.map((m) => m.content).join('\n');
		this.slots = {
			description: context.settings.description,
			lorebook: orderedLore(context.lorebook ?? [])
				.filter((e) => matchesLore(e, haystack))
				.map((e) => e.content)
				.join('\n\n'),
			memory: context.memories.map((m) => m.content).join('\n'),
			authornote: context.settings.authorNote
		};
	}
	private add(role: AIMessage['role'], content: string) {
		if (content.trim()) {
			this.result.push({ role, content });
		}
	}
	private appendChat(block: PromptBlock) {
		const end =
			block.rangeEnd === 'end' || block.rangeEnd === undefined ? undefined : block.rangeEnd;
		for (const message of this.chat.slice(block.rangeStart ?? 0, end)) {
			this.add(
				this.ai.promptSettings.sendChatAsSystem && !block.chatAsOriginalOnSystem
					? 'system'
					: message.role,
				message.content
			);
		}
	}
	private appendChatML(block: PromptBlock) {
		const pattern = /<\|im_start\|>(system|user|assistant|bot)\s*\n([\s\S]*?)<\|im_end\|>/g;
		const matches = [...(block.text ?? '').matchAll(pattern)];
		if (!matches.length && block.text?.trim()) {
			throw new Error('ChatML 프롬프트 형식을 확인해주세요.');
		}
		for (const match of matches) {
			this.add(match[1] === 'bot' ? 'assistant' : (match[1] as AIMessage['role']), match[2]);
		}
	}
	private cache(block: PromptBlock) {
		let remaining = block.depth ?? 1;
		for (let index = this.result.length - 1; index >= 0 && remaining > 0; index--) {
			const message = this.result[index];
			if (block.role === 'all' || message.role === normalizedRole(block.role)) {
				message.cache = true;
				remaining--;
			}
		}
	}
	private appendSlot(block: PromptBlock) {
		const value =
			block.type === 'persona' || block.type === 'postEverything'
				? (block.text ?? '')
				: this.slots[block.type] || (block.type === 'authornote' ? (block.defaultText ?? '') : '');
		if (value) {
			this.add(
				normalizedRole(block.role),
				block.innerFormat === undefined ? value : block.innerFormat.replaceAll('{{slot}}', value)
			);
		}
		if (block.type === 'postEverything') {
			this.add('system', this.ai.promptSettings.postEndInnerFormat);
		}
	}
	private append(block: PromptBlock) {
		if (block.enabled === false) {
			return;
		}
		if (['plain', 'jailbreak', 'cot'].includes(block.type)) {
			if (
				(block.type === 'jailbreak' && !this.ai.jailbreakEnabled) ||
				(block.type === 'cot' && !this.ai.cotEnabled)
			) {
				return;
			}
			this.add(normalizedRole(block.role), block.text ?? '');
			return;
		}
		if (block.type === 'chat') {
			return this.appendChat(block);
		}
		if (block.type === 'chatML') {
			return this.appendChatML(block);
		}
		if (block.type === 'cache') {
			return this.cache(block);
		}
		this.appendSlot(block);
	}
	assemble(): AIMessage[] {
		for (const block of this.ai.promptTemplate) {
			this.append(block);
		}
		if (this.context.transactions.length) {
			this.add(
				'system',
				'Committed game transactions:\n' +
					JSON.stringify(
						this.context.transactions.map((t) => ({
							action: t.action,
							changes: t.changes,
							description: t.description
						}))
					)
			);
		}
		this.add(
			'system',
			'Current game state (authoritative structured facts):\n' + JSON.stringify(this.context.state)
		);
		if (this.result.reduce((sum, m) => sum + m.content.length, 0) > this.ai.maxContextChars) {
			throw new Error('AI 컨텍스트 한도를 초과했어요. 프롬프트나 대화 범위를 조정해주세요.');
		}
		return this.result;
	}
}

function parsePromptRanges(item: Record<string, unknown>, block: PromptBlock) {
	for (const key of ['rangeStart', 'depth'] as const) {
		if (item[key] !== undefined) {
			if (!Number.isInteger(item[key]) || Math.abs(Number(item[key])) > 100000) {
				throw aiError('protocol');
			}
			block[key] = Number(item[key]);
		}
	}
	if (item.rangeEnd !== undefined) {
		if (item.rangeEnd !== 'end' && !Number.isInteger(item.rangeEnd)) {
			throw aiError('protocol');
		}
		block.rangeEnd = item.rangeEnd as number | 'end';
	}
}

function promptSpecialType(value: unknown): PromptBlock['type2'] {
	if (!['normal', 'globalNote', 'main'].includes(String(value))) {
		throw aiError('protocol');
	}
	return value as PromptBlock['type2'];
}

function matchesLegacyPrompt(block: PromptBlock, key: string): boolean {
	return key === 'mainPrompt' || key === 'globalNote'
		? ['plain', 'jailbreak', 'cot'].includes(block.type) &&
				block.type2 === (key === 'mainPrompt' ? 'main' : 'globalNote')
		: block.type === key;
}

function importedPromptRole(item: Record<string, unknown>): unknown {
	if (['plain', 'jailbreak', 'cot', 'cache'].includes(String(item.type))) {
		return item.role;
	}
	return ['persona', 'description', 'lorebook', 'postEverything', 'memory', 'authornote'].includes(
		String(item.type)
	)
		? item.role2
		: undefined;
}

function inactiveLegacyPrompt(
	key: 'mainPrompt' | 'globalNote' | 'persona' | 'postEverything',
	body: string
): PromptBlock {
	return {
		...(key === 'mainPrompt' || key === 'globalNote'
			? {
					type: 'plain' as const,
					type2: key === 'mainPrompt' ? ('main' as const) : ('globalNote' as const)
				}
			: { type: key }),
		text: body,
		enabled: false
	};
}
