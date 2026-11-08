import type { ToolDefinition } from '#lib/games/ai/protocol.js';

import { parseScripts, type Game } from '#lib/games/model.js';
import { parseAction, identifier, type Action } from '#lib/games/state/model.js';
import { parseObjectSchema, validateState, type ObjectSchema } from '#lib/games/state/schema.js';
import { parseGameState, type GameState } from '#lib/games/state/value.js';
import { parseStateValue, type StateValue } from '#lib/games/state/value.js';

/** Host policy; creator code cannot override these ceilings. */
export const SANDBOX_LIMITS = Object.freeze({
	wallTimeMs: 15_000,
	cpuTimeMs: 500,
	memoryBytes: 16 * 1024 * 1024,
	stackBytes: 256 * 1024,
	wireBytes: 2 * 1024 * 1024,
	sourceBytes: 512 * 1024,
	scriptCount: 32,
	actionCount: 256,
	ruleCount: 256,
	stepCount: 64,
	hookCount: 128,
	depth: 16,
	eventCount: 128,
	independentCount: 16
});
export const FAILURE_CODES = [
	'input',
	'compile',
	'script',
	'registration',
	'action-not-found',
	'arguments',
	'execution',
	'state',
	'timeout',
	'canceled',
	'protocol',
	'unavailable',
	'busy',
	'filter-rejected',
	'filter',
	'hook',
	'chain-limit',
	'reentry',
	'conflict',
	'storage'
] as const;
export type CreatorFailureCode = (typeof FAILURE_CODES)[number];
export class CreatorRuntimeError extends Error {
	constructor(
		public readonly code: CreatorFailureCode,
		public readonly scriptId: string | null = null,
		public readonly ruleId: string | null = null,
		public readonly reason: string | null = null
	) {
		super(`creator: ${code}${scriptId ? ` (${scriptId})` : ''}`);
		this.name = 'CreatorRuntimeError';
	}
}
export interface ActionRequest {
	scripts: Game['scripts'];
	schema: ObjectSchema;
	state: GameState;
	action: Action;
	operation?:
		| { kind: 'proposal' | 'validate'; state: GameState }
		| { kind: 'hook'; name: string; trigger: RuleTrigger }
		| { kind: 'catalog' }
		| { kind: 'query'; name: string; args: GameState };
}
export interface RuleTrigger {
	before: GameState;
	after: GameState;
	action: Action;
}
export interface UIEvent {
	name: string;
	payload: GameState;
}
export interface ActionResult {
	state: GameState;
	value?: StateValue;
	tools?: ToolDefinition[];
	description?: string;
	events?: UIEvent[];
	independentHooks?: string[];
}
export interface RunOptions {
	signal?: AbortSignal;
	lease?: string;
}
export type ActionRunner = (input: ActionRequest, options?: RunOptions) => Promise<ActionResult>;
export type WorkerReply =
	| { ok: true; result: ActionResult }
	| {
			ok: false;
			code: CreatorFailureCode;
			scriptId: string | null;
			ruleId?: string | null;
			reason?: string | null;
	  };

export function boundedText(text: string, limit = SANDBOX_LIMITS.wireBytes): string {
	if (
		typeof text !== 'string' ||
		text.length > limit ||
		new TextEncoder().encode(text).length > limit
	) {
		throw new CreatorRuntimeError('input');
	}
	return text;
}
export function encodeInput(value: ActionRequest): string {
	try {
		return boundedText(JSON.stringify(parseInput(value)));
	} catch (error) {
		if (error instanceof CreatorRuntimeError) {
			throw error;
		}
		throw new CreatorRuntimeError('input');
	}
}
export function parseInput(value: unknown): ActionRequest {
	const input = parseGameState(value);
	const scripts = parseScripts(input.scripts);
	if (Object.keys(scripts).length > SANDBOX_LIMITS.scriptCount) {
		throw new CreatorRuntimeError('input');
	}
	let bytes = 0;
	for (const [id, script] of Object.entries(scripts)) {
		if (id.length > 128 || !['javascript', 'typescript', 'js', 'ts'].includes(script.language)) {
			throw new CreatorRuntimeError('input');
		}
		bytes += new TextEncoder().encode(script.source).length;
	}
	if (bytes > SANDBOX_LIMITS.sourceBytes) {
		throw new CreatorRuntimeError('input');
	}
	const schema = parseObjectSchema(input.schema);
	const operation =
		input.operation === undefined ? undefined : parseOperation(input.operation, schema);
	return {
		scripts,
		schema,
		state: validateState(schema, input.state, 'load'),
		action: parseAction(input.action),
		...(operation ? { operation } : {})
	};
}
export function parseResult(value: unknown, schema: ObjectSchema): ActionResult {
	const result = parseGameState(value);
	if (
		result.description !== undefined &&
		(typeof result.description !== 'string' || result.description.length > 1024)
	) {
		throw new CreatorRuntimeError('protocol');
	}
	return {
		state: validateState(schema, result.state, 'commit'),
		...(result.value === undefined ? {} : { value: parseStateValue(result.value) }),
		...(result.tools === undefined ? {} : { tools: parseTools(result.tools) }),
		...(result.description === undefined ? {} : { description: identifier(result.description) }),
		...(result.events === undefined ? {} : { events: parseEvents(result.events) }),
		...(result.independentHooks === undefined
			? {}
			: { independentHooks: parseNames(result.independentHooks) })
	};
}
function parseTools(value: unknown): ToolDefinition[] {
	if (!Array.isArray(value) || value.length > SANDBOX_LIMITS.actionCount) {
		throw new CreatorRuntimeError('protocol');
	}
	return value.map((item) => {
		const row = parseGameState(item);
		if (!['action', 'query'].includes(String(row.kind)) || typeof row.description !== 'string') {
			throw new CreatorRuntimeError('protocol');
		}
		return {
			name: shortName(row.name),
			kind: row.kind as ToolDefinition['kind'],
			description: row.description,
			arguments: parseObjectSchema(row.arguments)
		};
	});
}
export function shortName(value: unknown): string {
	const name = identifier(value);
	if (name.length > 128) {
		throw new CreatorRuntimeError('protocol');
	}
	return name;
}
export function parseEvents(value: unknown): UIEvent[] {
	if (!Array.isArray(value) || value.length > SANDBOX_LIMITS.eventCount) {
		throw new CreatorRuntimeError('protocol');
	}
	return value.map((item) => {
		const event = parseGameState(item);
		return { name: shortName(event.name), payload: parseGameState(event.payload) };
	});
}
function parseNames(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > SANDBOX_LIMITS.ruleCount) {
		throw new CreatorRuntimeError('protocol');
	}
	const names = value.map(shortName);
	if (new Set(names).size !== names.length) {
		throw new CreatorRuntimeError('protocol');
	}
	return names;
}

function parseOperation(
	value: unknown,
	schema: ReturnType<typeof parseObjectSchema>
): ActionRequest['operation'] {
	let operation: ActionRequest['operation'];
	const item = parseGameState(value);
	if (item.kind === 'proposal' || item.kind === 'validate') {
		operation = { kind: item.kind, state: validateState(schema, item.state, 'commit') };
	} else if (item.kind === 'catalog') {
		operation = { kind: 'catalog' };
	} else if (item.kind === 'query') {
		operation = { kind: 'query', name: shortName(item.name), args: parseGameState(item.args) };
	} else if (item.kind === 'hook') {
		const trigger = parseGameState(item.trigger);
		operation = {
			kind: 'hook',
			name: shortName(item.name),
			trigger: {
				before: validateState(schema, trigger.before, 'load'),
				after: validateState(schema, trigger.after, 'load'),
				action: parseAction(trigger.action)
			}
		};
	} else {
		throw new CreatorRuntimeError('input');
	}

	return operation;
}
