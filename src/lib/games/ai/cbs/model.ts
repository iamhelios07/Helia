import type { GameState } from '#lib/games/state/value.js';

export interface CBSContext {
	toggles?: Readonly<Record<string, string>>;
	state: GameState;
	game?: string;
	persona?: { name: string; description: string };
	description?: string;
	authornote?: string;
}
export type CBSNode =
	| { type: 'text'; value: string }
	| { type: 'call'; name: string; args: CBSNode[][]; source: string }
	| { type: 'when'; args: CBSNode[][]; yes: CBSNode[]; no: CBSNode[] }
	| { type: 'literal'; value: string };
export const CBS_LIMITS = {
	source: 512 * 1024,
	output: 2 * 1024 * 1024,
	depth: 32,
	nodes: 10000,
	steps: 20000,
	collection: 10000
} as const;

export function cbsError(message: string): Error {
	return new Error(`CBS: ${message}`);
}
export function bounded(value: string): string {
	if (value.length > CBS_LIMITS.output) {
		throw cbsError('출력 크기 한도를 초과했어요.');
	}
	return value;
}
export function stringify(value: unknown): string {
	if (value === undefined || value === null) {
		return 'null';
	}
	if (typeof value === 'string') {
		return bounded(value);
	}
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch {
		throw cbsError('JSON 값의 형식이나 중첩을 확인해주세요.');
	}
	return bounded(serialized);
}
export function truth(value: string): boolean {
	return value === '1' || value === 'true';
}
export function numeric(value: string): number {
	const number = Number(value);
	if (!value.trim() || !Number.isFinite(number)) {
		throw cbsError('유한한 숫자가 필요해요.');
	}
	return number;
}
export function element(value: unknown, key: string): unknown {
	if (['__proto__', 'prototype', 'constructor'].includes(key)) {
		throw cbsError('허용되지 않는 조회 경로예요.');
	}
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	return Object.getOwnPropertyDescriptor(value, key)?.value;
}
