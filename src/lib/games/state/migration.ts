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
	return validateState(
		next,
		migrateValue(value, { old: previous, target: next, fallback: initial, path: [] }),
		'load'
	);
}

interface MigrationStep {
	old: ValueSchema;
	target: ValueSchema;
	fallback: StateValue | undefined;
	path: string[];
}
function migrateValue(
	value: StateValue,
	{ old, target, fallback, path }: MigrationStep
): StateValue {
	const type = schemaType(target);
	const oldType = schemaType(old);
	let candidate: StateValue = value;
	if (value === null) {
		if (target.type === 'null' || (Array.isArray(target.type) && target.type.includes('null'))) {
			return null;
		}
		if (fallback === undefined) {
			throw Error('새 초기값이 필요해요: ' + path.join('.'));
		}
		return validateValue(target, fallback, 'initial');
	}
	if (
		type === 'object' &&
		isStateObject(value) &&
		oldType === 'object' &&
		'properties' in old &&
		'properties' in target
	) {
		candidate = migrateObject(value, { old, target, fallback, path });
	} else if (type === 'array' && Array.isArray(value) && 'items' in old && 'items' in target) {
		candidate = value.map((item, index) =>
			migrateValue(item, {
				old: old.items,
				target: target.items,
				fallback: arrayFallback(fallback, index),
				path: [...path, String(index)]
			})
		);
	} else if (type !== oldType) {
		return convertValue(value, target, fallback, path);
	}
	return validateValue(target, candidate, 'load');
}
function migrateObject(
	value: GameState,
	{
		old,
		target,
		fallback,
		path
	}: MigrationStep & {
		old: ValueSchema & { properties: Record<string, ValueSchema> };
		target: ValueSchema & { properties: Record<string, ValueSchema>; required?: string[] };
	}
): GameState {
	const result: GameState = {};
	for (const [key, child] of Object.entries(target.properties)) {
		const childFallback = objectFallback(fallback, key);
		if (Object.hasOwn(old.properties, key) && Object.hasOwn(value, key)) {
			result[key] = migrateValue(value[key], {
				old: old.properties[key],
				target: child,
				fallback: childFallback,
				path: [...path, key]
			});
		} else if (!Object.hasOwn(old.properties, key) && childFallback !== undefined) {
			result[key] = structuredClone(childFallback);
		} else if (target.required?.includes(key)) {
			if (childFallback === undefined) {
				throw Error('새 필드의 초기값이 필요해요: ' + [...path, key].join('.'));
			}
			result[key] = structuredClone(childFallback);
		}
	}
	return result;
}
function convertValue(
	value: StateValue,
	target: ValueSchema,
	fallback: StateValue | undefined,
	path: string[]
): StateValue {
	const type = schemaType(target);
	let candidate = value;
	if (type === 'string' && ['number', 'boolean', 'string'].includes(typeof value)) {
		candidate = String(value);
	} else if (
		(type === 'number' || type === 'integer') &&
		typeof value === 'string' &&
		value.trim() !== '' &&
		Number.isFinite(Number(value))
	) {
		candidate = Number(value);
	} else if (type === 'boolean' && (value === 'true' || value === 1)) {
		candidate = true;
	} else if (type === 'boolean' && (value === 'false' || value === 0)) {
		candidate = false;
	}
	try {
		return validateValue(target, candidate, 'load');
	} catch {
		if (fallback === undefined) {
			throw Error('타입 변경에 사용할 초기값이 필요해요: ' + path.join('.'));
		}
		return validateValue(target, fallback, 'initial');
	}
}

function arrayFallback(fallback: StateValue | undefined, index: number): StateValue | undefined {
	if (!Array.isArray(fallback)) {
		return undefined;
	}
	return index < fallback.length ? fallback[index] : fallback[0];
}

function objectFallback(fallback: StateValue | undefined, key: string): StateValue | undefined {
	if (fallback === undefined || !isStateObject(fallback)) {
		return undefined;
	}
	return fallback[key];
}
