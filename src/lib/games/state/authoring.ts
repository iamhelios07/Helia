import {
	parseObjectSchema,
	parseSchema,
	schemaType,
	validateState,
	type ObjectSchema,
	type ValueSchema
} from './schema.js';
import {
	isStateObject,
	parseGameState,
	validateStateKey,
	type GameState,
	type StateValue
} from './value.js';

/** A string selects an object property; null selects every array item. */
export type SchemaTrail = readonly (string | null)[];
export type AuthoringType =
	'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
export interface AuthoringDocument {
	schema: ObjectSchema;
	initialState: GameState;
}
export type SchemaEdit =
	| { kind: 'type'; type: AuthoringType }
	| { kind: 'nullable'; enabled: boolean }
	| { kind: 'metadata'; key: 'title' | 'description'; value: string }
	| { kind: 'enum'; values: StateValue[] | undefined }
	| { kind: 'add'; name: string }
	| { kind: 'rename'; name: string; next: string }
	| { kind: 'remove'; name: string }
	| { kind: 'required'; name: string; enabled: boolean };

export function objectShape(schema: ValueSchema): ObjectSchema | null {
	return schemaType(schema) === 'object' ? (schema as ObjectSchema) : null;
}
export function arrayItem(schema: ValueSchema): ValueSchema | null {
	return schemaType(schema) === 'array'
		? (schema as ValueSchema & { items: ValueSchema }).items
		: null;
}
export function allowsNull(schema: ValueSchema): boolean {
	return schema.type === 'null' || Array.isArray(schema.type);
}
export function createValueSchema(type: AuthoringType): ValueSchema {
	if (type === 'object') {
		return { type, properties: {}, additionalProperties: false };
	}
	if (type === 'array') {
		return { type, items: { type: 'string' } };
	}
	return { type };
}

/** Only used for explicit user operations, never while parsing or rendering source. */
export function initialValueFor(schema: ValueSchema): StateValue {
	if (schema.enum) {
		return structuredClone(schema.enum[0]);
	}
	const object = objectShape(schema);
	if (object) {
		return Object.fromEntries(
			(object.required ?? []).map((key) => [key, initialValueFor(object.properties[key])])
		);
	}
	if (arrayItem(schema)) {
		return [];
	}
	switch (schemaType(schema)) {
		case 'string':
			return '';
		case 'number':
		case 'integer':
			return 0;
		case 'boolean':
			return false;
		default:
			return null;
	}
}

export function readAuthoringSource(
	source: string
):
	| { document: AuthoringDocument; error: null; validationError: string | null }
	| { document: null; error: string; validationError: null } {
	try {
		const value: unknown = JSON.parse(source);
		if (
			typeof value !== 'object' ||
			value === null ||
			Array.isArray(value) ||
			Object.keys(value).some((key) => !['schema', 'initialState'].includes(key))
		) {
			throw new Error('상태 문서에는 schema와 initialState 필드가 필요해요.');
		}
		const fields = value as Record<string, unknown>;
		const schema = parseObjectSchema(fields.schema);
		const initialState = parseGameState(fields.initialState);
		let validationError: string | null = null;
		try {
			validateState(schema, initialState, 'initial');
		} catch (error) {
			validationError = error instanceof Error ? error.message : String(error);
		}
		return { document: { schema, initialState }, error: null, validationError };
	} catch (error) {
		return {
			document: null,
			error: error instanceof Error ? error.message : String(error),
			validationError: null
		};
	}
}

function schemaAt(schema: ValueSchema, trail: SchemaTrail): ValueSchema {
	if (!trail.length) {
		return schema;
	}
	const [head, ...tail] = trail;
	const child = head === null ? arrayItem(schema) : objectShape(schema)?.properties[head];
	if (!child) {
		throw new Error('편집할 필드를 찾을 수 없어요.');
	}
	return schemaAt(child, tail);
}
function mapValues(
	value: StateValue,
	trail: SchemaTrail,
	change: (value: StateValue) => StateValue
): StateValue {
	if (!trail.length) {
		return change(value);
	}
	const [head, ...tail] = trail;
	if (head === null) {
		return Array.isArray(value) ? value.map((item) => mapValues(item, tail, change)) : value;
	}
	if (!isStateObject(value) || !Object.hasOwn(value, head)) {
		return value;
	}
	return { ...value, [head]: mapValues(value[head], tail, change) };
}

export function editAuthoringSchema(
	document: AuthoringDocument,
	trail: SchemaTrail,
	edit: SchemaEdit
): AuthoringDocument {
	const schema = structuredClone(document.schema);
	const node = schemaAt(schema, trail);
	let initialState: StateValue = structuredClone(document.initialState);
	const { replacement, valueChange } = changeSchemaNode(node, trail, edit);

	if (replacement) {
		for (const key of Object.keys(node)) {
			delete (node as unknown as Record<string, unknown>)[key];
		}
		Object.assign(node, replacement);
	}
	parseSchema(schema);
	if (valueChange) {
		initialState = mapValues(initialState, trail, valueChange);
	}
	return { schema: parseObjectSchema(schema), initialState: parseGameState(initialState) };
}

type NodeEditResult = {
	replacement?: ValueSchema;
	valueChange?: (value: StateValue) => StateValue;
};
function changeNodeType(
	node: ValueSchema,
	trail: SchemaTrail,
	edit: Extract<SchemaEdit, { kind: 'type' }>
): NodeEditResult {
	if (!trail.length && edit.type !== 'object') {
		throw new Error('최상위 상태는 객체여야 해요.');
	}
	const replacement: ValueSchema = {
		...createValueSchema(edit.type),
		...(node.title !== undefined ? { title: node.title } : {}),
		...(node.description !== undefined ? { description: node.description } : {})
	};
	const valueChange = () => initialValueFor(replacement);
	return { replacement, valueChange };
}
function changeNodeNullability(
	node: ValueSchema,
	trail: SchemaTrail,
	edit: Extract<SchemaEdit, { kind: 'nullable' }>
): NodeEditResult {
	let valueChange: NodeEditResult['valueChange'];
	if (!trail.length || schemaType(node) === 'null') {
		throw new Error('이 필드의 null 허용 여부는 바꿀 수 없어요.');
	}
	node.type = edit.enabled
		? ([schemaType(node), 'null'] as ValueSchema['type'])
		: (schemaType(node) as ValueSchema['type']);
	if (!edit.enabled) {
		valueChange = (value) => (value === null ? initialValueFor(node) : value);
	}
	return { valueChange };
}
function changeObjectNode(
	node: ValueSchema,
	edit: Extract<SchemaEdit, { kind: 'add' | 'rename' | 'remove' | 'required' }>
): NodeEditResult {
	let valueChange: NodeEditResult['valueChange'];
	const object = objectShape(node);
	if (!object) {
		throw new Error('객체 필드에서만 가능한 작업이에요.');
	}
	validateStateKey(edit.name);
	if (edit.kind === 'add' || edit.kind === 'rename') {
		return changeObjectName(object, edit);
	} else if (edit.kind === 'remove') {
		delete object.properties[edit.name];
		if (object.required) {
			object.required = object.required.filter((key) => key !== edit.name);
		}
		valueChange = (value) => {
			if (isStateObject(value)) {
				delete value[edit.name];
			}
			return value;
		};
	} else {
		const required = new Set(object.required ?? []);
		if (edit.enabled) {
			required.add(edit.name);
		} else {
			required.delete(edit.name);
		}
		object.required = [...required];
		if (edit.enabled) {
			valueChange = (value) =>
				isStateObject(value) && !Object.hasOwn(value, edit.name)
					? { ...value, [edit.name]: initialValueFor(object.properties[edit.name]) }
					: value;
		}
	}
	return { valueChange };
}
function changeSchemaNode(node: ValueSchema, trail: SchemaTrail, edit: SchemaEdit): NodeEditResult {
	switch (edit.kind) {
		case 'type':
			return changeNodeType(node, trail, edit);
		case 'nullable':
			return changeNodeNullability(node, trail, edit);
		case 'metadata':
			if (edit.value) {
				node[edit.key] = edit.value;
			} else {
				delete node[edit.key];
			}
			return {};
		case 'enum':
			if (edit.values) {
				node.enum = structuredClone(edit.values);
			} else {
				delete node.enum;
			}
			return {};
		default:
			return changeObjectNode(node, edit);
	}
}

function changeObjectName(
	object: ObjectSchema,
	edit: Extract<SchemaEdit, { kind: 'add' | 'rename' }>
): NodeEditResult {
	let valueChange: NodeEditResult['valueChange'];

	const name = edit.kind === 'add' ? edit.name : edit.next;
	validateStateKey(name);
	if (!name.trim()) {
		throw new Error('필드 이름을 입력해주세요.');
	}
	if (Object.hasOwn(object.properties, name)) {
		throw new Error('이미 사용 중인 필드 이름이에요.');
	}
	if (edit.kind === 'add') {
		object.properties[name] = { type: 'string' };
	} else {
		if (!Object.hasOwn(object.properties, edit.name)) {
			throw new Error('필드를 찾을 수 없어요.');
		}
		object.properties = Object.fromEntries(
			Object.entries(object.properties).map(([key, child]) => [
				key === edit.name ? name : key,
				child
			])
		);
		if (object.required) {
			object.required = object.required.map((key) => (key === edit.name ? name : key));
		}
		valueChange = (value) => {
			if (!isStateObject(value) || !Object.hasOwn(value, edit.name)) {
				return value;
			}
			if (Object.hasOwn(value, name)) {
				throw new Error('초기 상태에 새 이름의 값이 이미 있어요. JSON에서 먼저 확인해주세요.');
			}
			return Object.fromEntries(
				Object.entries(value).map(([key, item]) => [key === edit.name ? name : key, item])
			);
		};
	}

	return { valueChange };
}
