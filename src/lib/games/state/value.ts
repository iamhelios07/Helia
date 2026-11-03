export type StateValue = null | boolean | number | string | StateValue[] | GameState;
export interface GameState {
	[key: string]: StateValue;
}

const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);

export function validateStateKey(key: unknown): asserts key is string {
	if (typeof key !== 'string' || forbiddenKeys.has(key))
		throw new Error('허용되지 않는 상태 경로예요.');
}

/** Validate and detach JSON data; reject values JSON.stringify would silently change. */
export function parseStateValue(value: unknown, ancestors = new Set<object>()): StateValue {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value !== 'object' || value === null || ancestors.has(value))
		throw new Error('상태는 순환 참조 없는 JSON 데이터여야 해요.');
	const prototype = Object.getPrototypeOf(value);
	if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
		throw new Error('상태에 클래스 인스턴스를 저장할 수 없어요.');
	if (Object.getOwnPropertySymbols(value).length)
		throw new Error('상태에 Symbol을 저장할 수 없어요.');
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			if (
				Object.keys(value).length !== value.length ||
				Object.getOwnPropertyNames(value).length !== value.length + 1
			)
				throw new Error('비어 있는 배열 항목이나 추가 속성을 저장할 수 없어요.');
			const result: StateValue[] = [];
			for (let index = 0; index < value.length; index++) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				if (!descriptor || !('value' in descriptor))
					throw new Error('상태에 접근자를 저장할 수 없어요.');
				result.push(parseStateValue(descriptor.value, ancestors));
			}
			return result;
		}
		const result: GameState = {};
		for (const key of Object.getOwnPropertyNames(value)) {
			validateStateKey(key);
			const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
			if (!descriptor.enumerable || !('value' in descriptor))
				throw new Error('상태에 숨겨진 속성이나 접근자를 저장할 수 없어요.');
			result[key] = parseStateValue(descriptor.value, ancestors);
		}
		return result;
	} finally {
		ancestors.delete(value);
	}
}

export function parseGameState(value: unknown): GameState {
	const parsed = parseStateValue(value);
	if (!isStateObject(parsed)) throw new Error('게임 상태의 최상위 값은 객체여야 해요.');
	return parsed;
}

export function isStateObject(value: StateValue): value is GameState {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sameValue(first: StateValue, second: StateValue): boolean {
	if (first === second) return true;
	if (Array.isArray(first) && Array.isArray(second))
		return (
			first.length === second.length && first.every((item, index) => sameValue(item, second[index]))
		);
	if (isStateObject(first) && isStateObject(second)) {
		const keys = Object.keys(first);
		return (
			keys.length === Object.keys(second).length &&
			keys.every((key) => Object.hasOwn(second, key) && sameValue(first[key], second[key]))
		);
	}
	return false;
}
