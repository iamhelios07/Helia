import {
	schemaType,
	validateValue,
	validateState,
	type ValueSchema,
	type ObjectSchema
} from './schema.js';
import { isStateObject, type StateValue, type GameState } from './value.js';

/** Explicit content migration only. Normal validation never inserts defaults or coerces values. */
export function migrateState(
	value: GameState,
	previous: ObjectSchema,
	next: ObjectSchema,
	initial: GameState
): GameState {
	function visit(
		value: StateValue,
		old: ValueSchema,
		target: ValueSchema,
		fallback: StateValue | undefined,
		path: string[]
	): StateValue {
		const type = schemaType(target);
		const oldType = schemaType(old);
		let candidate: StateValue = value;
		if (value === null) {
			if (target.type === 'null' || (Array.isArray(target.type) && target.type.includes('null')))
				return null;
			if (fallback === undefined) throw Error('새 초기값이 필요해요: ' + path.join('.'));
			return validateValue(target, fallback, 'initial');
		}
		if (
			type === 'object' &&
			isStateObject(value) &&
			oldType === 'object' &&
			'properties' in old &&
			'properties' in target
		) {
			const result: GameState = {};
			for (const [key, child] of Object.entries(target.properties)) {
				const childFallback =
					fallback !== undefined && isStateObject(fallback) ? fallback[key] : undefined;
				if (Object.hasOwn(old.properties, key) && Object.hasOwn(value, key))
					result[key] = visit(value[key], old.properties[key], child, childFallback, [
						...path,
						key
					]);
				else if (!Object.hasOwn(old.properties, key) && childFallback !== undefined)
					result[key] = structuredClone(childFallback);
				else if (target.required?.includes(key)) {
					if (childFallback === undefined)
						throw Error('새 필드의 초기값이 필요해요: ' + [...path, key].join('.'));
					result[key] = structuredClone(childFallback);
				}
			}
			candidate = result;
		} else if (type === 'array' && Array.isArray(value) && 'items' in old && 'items' in target) {
			candidate = value.map((item, index) =>
				visit(
					item,
					old.items,
					target.items,
					Array.isArray(fallback)
						? index < fallback.length
							? fallback[index]
							: fallback[0]
						: undefined,
					[...path, String(index)]
				)
			);
		} else if (type !== oldType) {
			if (type === 'string' && ['number', 'boolean', 'string'].includes(typeof value))
				candidate = String(value);
			else if (
				(type === 'number' || type === 'integer') &&
				typeof value === 'string' &&
				value.trim() !== '' &&
				Number.isFinite(Number(value))
			)
				candidate = Number(value);
			else if (type === 'boolean' && (value === 'true' || value === 1)) candidate = true;
			else if (type === 'boolean' && (value === 'false' || value === 0)) candidate = false;
			try {
				return validateValue(target, candidate, 'load');
			} catch {
				if (fallback === undefined)
					throw Error('타입 변경에 사용할 초기값이 필요해요: ' + path.join('.'));
				return validateValue(target, fallback, 'initial');
			}
		}
		return validateValue(target, candidate, 'load');
	}
	return validateState(next, visit(value, previous, next, initial, []), 'load');
}
