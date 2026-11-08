import { parseGameState, type GameState } from '#lib/games/state/value.js';

export interface PanelInfo {
	id: string;
	title: string;
}
export interface PanelView {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

export type PanelLayout =
	| { kind: 'panel'; id: string }
	| {
			kind: 'split';
			axis: 'horizontal' | 'vertical';
			ratio: number;
			first: PanelLayout;
			second: PanelLayout;
	  };
export interface GameUI {
	version: 1;
	entry: string;
	modules: Record<
		string,
		{ language: 'jsx' | 'tsx' | 'javascript' | 'typescript'; source: string }
	>;
	layout?: PanelLayout;
	chatDock?: 'left' | 'right' | 'top' | 'bottom';
	chatRatio?: number;
	chatStyle?: {
		background?: string;
		color?: string;
		fontFamily?: string;
		userBackground?: string;
		assistantBackground?: string;
	};
}
export const UI_LIMITS = Object.freeze({
	panels: 16,
	modules: 32,
	sourceBytes: 512 * 1024,
	wireBytes: 2 * 1024 * 1024,
	pending: 16
});

export function parsePanelLayout(value: unknown): PanelLayout {
	const seen = new Set<string>();
	function visit(input: unknown, depth: number): PanelLayout {
		if (depth > 8 || !input || typeof input !== 'object') {
			throw Error('Invalid panel layout');
		}
		const node = input as Record<string, unknown>;
		if (
			node.kind === 'panel' &&
			typeof node.id === 'string' &&
			/^[\w-]{1,80}$/.test(node.id) &&
			!seen.has(node.id) &&
			seen.size < UI_LIMITS.panels
		) {
			seen.add(node.id);
			return { kind: 'panel', id: node.id };
		}
		if (
			node.kind !== 'split' ||
			!['horizontal', 'vertical'].includes(String(node.axis)) ||
			typeof node.ratio !== 'number' ||
			!Number.isFinite(node.ratio) ||
			node.ratio < 0.1 ||
			node.ratio > 0.9
		) {
			throw Error('Invalid panel layout');
		}
		return {
			kind: 'split',
			axis: node.axis as 'horizontal' | 'vertical',
			ratio: node.ratio,
			first: visit(node.first, depth + 1),
			second: visit(node.second, depth + 1)
		};
	}
	return visit(value, 0);
}

function parseModules(value: GameState): GameUI['modules'] {
	const entries = Object.entries(value);
	if (!entries.length || entries.length > UI_LIMITS.modules) {
		throw Error('게임 UI 모듈 수를 확인해주세요.');
	}
	let bytes = 0;
	const modules: GameUI['modules'] = {};
	for (const [id, item] of entries) {
		if (
			['preact', 'preact/hooks'].includes(id) ||
			!/^[\w][\w./-]{0,127}$/.test(id) ||
			id.split('/').some((part) => !part || part === '.' || part === '..') ||
			!item ||
			typeof item !== 'object' ||
			Array.isArray(item) ||
			!['jsx', 'tsx', 'javascript', 'typescript'].includes(String(item.language)) ||
			typeof item.source !== 'string'
		) {
			throw Error('게임 UI 모듈이 올바르지 않아요.');
		}
		bytes += new TextEncoder().encode(item.source).length;
		if (bytes > UI_LIMITS.sourceBytes) {
			throw Error('게임 UI 소스가 너무 커요.');
		}
		modules[id] = {
			language: item.language as GameUI['modules'][string]['language'],
			source: item.source
		};
	}
	return modules;
}

function parseChatOptions(input: ReturnType<typeof parseGameState>, result: GameUI): void {
	if (input.chatDock !== undefined) {
		if (!['left', 'right', 'top', 'bottom'].includes(String(input.chatDock))) {
			throw Error('Invalid chat dock');
		}
		result.chatDock = input.chatDock as GameUI['chatDock'];
	}
	if (input.chatRatio !== undefined) {
		if (
			typeof input.chatRatio !== 'number' ||
			!Number.isFinite(input.chatRatio) ||
			input.chatRatio < 0.2 ||
			input.chatRatio > 0.8
		) {
			throw Error('Invalid chat ratio');
		}
		result.chatRatio = input.chatRatio;
	}
	if (input.chatStyle !== undefined) {
		result.chatStyle = parseChatStyle(input.chatStyle);
	}
}

function parseChatStyle(value: unknown): NonNullable<GameUI['chatStyle']> {
	const style = parseGameState(value);
	const result: NonNullable<GameUI['chatStyle']> = {};
	for (const [key, color] of Object.entries(style)) {
		if (
			!['background', 'color', 'fontFamily', 'userBackground', 'assistantBackground'].includes(
				key
			) ||
			typeof color !== 'string' ||
			color.length > 100 ||
			!(key === 'fontFamily' ? /^[\p{L}\p{N}\s,"'-]+$/u : /^(#[\da-f]{3,8}|[a-z]+)$/i).test(color)
		) {
			throw Error('Invalid chat style');
		}
		result[key as keyof NonNullable<GameUI['chatStyle']>] = color;
	}
	return result;
}

export function parseGameUI(value: unknown): GameUI {
	const input = parseGameState(value);
	if (
		input.version !== 1 ||
		typeof input.entry !== 'string' ||
		!input.modules ||
		typeof input.modules !== 'object' ||
		Array.isArray(input.modules)
	) {
		throw Error('게임 UI 형식이 올바르지 않아요.');
	}
	const modules = parseModules(input.modules);
	if (!Object.hasOwn(modules, input.entry)) {
		throw Error('게임 UI 진입점을 찾을 수 없어요.');
	}
	const result: GameUI = { version: 1, entry: input.entry, modules };
	if (input.layout !== undefined) {
		result.layout = parsePanelLayout(input.layout);
	}
	parseChatOptions(input, result);
	return result;
}
