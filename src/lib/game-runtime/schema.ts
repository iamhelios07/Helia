import {
	isStateObject,
	parseGameState,
	parseStateValue,
	sameValue,
	type GameState,
	type StateValue
} from './value.js';

export type PrimitiveType = 'string' | 'number' | 'integer' | 'boolean' | 'null';
type Nullable<T extends string> = T | [T, 'null'] | ['null', T];
interface SchemaBase {
	title?: string;
	description?: string;
	enum?: StateValue[];
}
export type ValueSchema = SchemaBase &
	(
		| { type: Nullable<Exclude<PrimitiveType, 'null'>> | 'null' }
		| { type: Nullable<'array'>; items: ValueSchema }
		| {
				type: Nullable<'object'>;
				properties: Record<string, ValueSchema>;
				required?: string[];
				additionalProperties: false;
		  }
	);
export type ObjectSchema = SchemaBase & {
	type: 'object';
	properties: Record<string, ValueSchema>;
	required?: string[];
	additionalProperties: false;
};
export interface StateDocument {
	schema: ObjectSchema;
	initialState: GameState;
}
export type ValidationPhase = 'schema' | 'initial' | 'load' | 'arguments' | 'commit';
export class StateValidationError extends Error {
	constructor(
		public readonly phase: ValidationPhase,
		public readonly path: readonly (string | number)[],
		public readonly code: string
	) {
		super(`${phase}: ${JSON.stringify(path)} — ${code}`);
		this.name = 'StateValidationError';
	}
}
function fail(phase: ValidationPhase, path: readonly (string | number)[], code: string): never {
	throw new StateValidationError(phase, path, code);
}
export function schemaType(schema: ValueSchema): string {
	return Array.isArray(schema.type) ? schema.type.find((type) => type !== 'null')! : schema.type;
}

/** Parse a closed, explicitly typed JSON Schema profile. No implicit keyword defaults or coercion. */
export function parseSchema(value: unknown): ValueSchema {
	let input: GameState;
	try {
		input = parseGameState(value);
	} catch {
		return fail('schema', [], 'invalid-json-schema');
	}
	function visit(node: StateValue, path: (string | number)[], depth: number): ValueSchema {
		if (depth > 64 || !isStateObject(node)) fail('schema', path, 'invalid-schema');
		const types = Array.isArray(node.type) ? node.type : [node.type];
		if (
			!types.length ||
			types.some(
				(type) =>
					typeof type !== 'string' ||
					!['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type)
			) ||
			new Set(types).size !== types.length ||
			(Array.isArray(node.type) && (types.length !== 2 || !types.includes('null')))
		)
			fail('schema', [...path, 'type'], 'unsupported-type');
		const type = types.find((type) => type !== 'null') ?? 'null';
		const allowed = [
			'type',
			'title',
			'description',
			'enum',
			...(type === 'object'
				? ['properties', 'required', 'additionalProperties']
				: type === 'array'
					? ['items']
					: [])
		];
		for (const key of Object.keys(node))
			if (!allowed.includes(key)) fail('schema', [...path, key], 'unsupported-keyword');
		for (const key of ['title', 'description'])
			if (Object.hasOwn(node, key) && typeof node[key] !== 'string')
				fail('schema', [...path, key], 'expected-string');
		if (type === 'object') {
			if (!isStateObject(node.properties))
				fail('schema', [...path, 'properties'], 'expected-properties');
			if (node.additionalProperties !== false)
				fail('schema', [...path, 'additionalProperties'], 'closed-object-required');
			for (const [key, child] of Object.entries(node.properties))
				visit(child, [...path, 'properties', key], depth + 1);
			if (Object.hasOwn(node, 'required')) {
				const required = node.required;
				if (
					!Array.isArray(required) ||
					required.some(
						(key) => typeof key !== 'string' || !Object.hasOwn(node.properties as GameState, key)
					) ||
					new Set(required).size !== required.length
				)
					fail('schema', [...path, 'required'], 'invalid-required');
			}
		} else if (type === 'array') visit(node.items, [...path, 'items'], depth + 1);
		if (Object.hasOwn(node, 'enum')) {
			const values = node.enum;
			if (!Array.isArray(values) || !values.length)
				fail('schema', [...path, 'enum'], 'invalid-enum');
			const withoutEnum = { ...node };
			delete withoutEnum.enum;
			values.forEach((item, index) => {
				check(withoutEnum as unknown as ValueSchema, item, 'schema', [...path, 'enum', index]);
				if (values.slice(0, index).some((other) => sameValue(item, other)))
					fail('schema', [...path, 'enum', index], 'duplicate-enum');
			});
		}
		return node as unknown as ValueSchema;
	}
	return visit(input, [], 0);
}
export function parseObjectSchema(value: unknown): ObjectSchema {
	const schema = parseSchema(value);
	if (schema.type !== 'object') fail('schema', [], 'root-must-be-object');
	return schema as ObjectSchema;
}
function check(
	schema: ValueSchema,
	value: StateValue,
	phase: ValidationPhase,
	path: (string | number)[]
): void {
	if (schema.enum && !schema.enum.some((item) => sameValue(item, value))) fail(phase, path, 'enum');
	if (
		value === null &&
		(schema.type === 'null' || (Array.isArray(schema.type) && schema.type.includes('null')))
	)
		return;
	const type = schemaType(schema);
	if (type === 'object') {
		if (!isStateObject(value)) fail(phase, path, 'expected-object');
		const object = schema as ObjectSchema;
		for (const key of object.required ?? [])
			if (!Object.hasOwn(value, key)) fail(phase, [...path, key], 'required');
		for (const [key, item] of Object.entries(value)) {
			if (!Object.hasOwn(object.properties, key))
				fail(phase, [...path, key], 'additional-property');
			check(object.properties[key], item, phase, [...path, key]);
		}
	} else if (type === 'array') {
		if (!Array.isArray(value)) fail(phase, path, 'expected-array');
		value.forEach((item, index) =>
			check((schema as ValueSchema & { items: ValueSchema }).items, item, phase, [...path, index])
		);
	} else if (type === 'null') {
		if (value !== null) fail(phase, path, 'expected-null');
	} else if (type === 'integer') {
		if (typeof value !== 'number' || !Number.isInteger(value))
			fail(phase, path, 'expected-integer');
	} else if (typeof value !== type) fail(phase, path, `expected-${type}`);
}
export function validateValue(schema: unknown, value: unknown, phase: ValidationPhase): StateValue {
	const parsed = parseSchema(schema);
	let detached: StateValue;
	try {
		detached = parseStateValue(value);
	} catch {
		return fail(phase, [], 'invalid-json');
	}
	check(parsed, detached, phase, []);
	return detached;
}
export function validateState(schema: unknown, value: unknown, phase: ValidationPhase): GameState {
	return validateValue(parseObjectSchema(schema), value, phase) as GameState;
}
export function parseStateDocument(value: unknown): StateDocument {
	if (
		typeof value !== 'object' ||
		value === null ||
		Array.isArray(value) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
		Object.getOwnPropertySymbols(value).length
	)
		fail('schema', [], 'invalid-document');
	const fields = Object.getOwnPropertyDescriptors(value);
	for (const [key, field] of Object.entries(fields)) {
		if (!['schema', 'initialState'].includes(key))
			fail('schema', [key], 'unsupported-document-field');
		if (!field.enumerable || !('value' in field))
			fail(key === 'initialState' ? 'initial' : 'schema', [key], 'invalid-json');
	}
	const schema = parseObjectSchema(fields.schema?.value);
	return { schema, initialState: validateState(schema, fields.initialState?.value, 'initial') };
}
export function emptyStateDocument(): StateDocument {
	return {
		schema: { type: 'object', properties: {}, additionalProperties: false },
		initialState: {}
	};
}

/** Generates a standalone declaration without executing creator code. */
export function generateStateTypes(schema: unknown): string {
	function literal(value: StateValue): string {
		if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
		if (isStateObject(value))
			return `{ ${Object.entries(value)
				.map(([key, item]) => `${JSON.stringify(key)}: ${literal(item)}`)
				.join('; ')} }`;
		return JSON.stringify(value);
	}
	function emit(node: ValueSchema): string {
		if (node.enum) return node.enum.map(literal).join(' | ');
		const type = schemaType(node);
		let result: string;
		if (type === 'object') {
			const object = node as ObjectSchema;
			result = `{ ${Object.entries(object.properties)
				.map(
					([key, child]) =>
						`${JSON.stringify(key)}${object.required?.includes(key) ? '' : '?'}: ${emit(child)}`
				)
				.join('; ')} }`;
		} else if (type === 'array')
			result = `Array<${emit((node as ValueSchema & { items: ValueSchema }).items)}>`;
		else result = type === 'integer' ? 'number' : type;
		return Array.isArray(node.type) ? `${result} | null` : result;
	}
	return `export type GameState = ${emit(parseObjectSchema(schema))};\n`;
}
