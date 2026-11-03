import { diffState } from './changes.js';
import { parseAction, type Action } from './model.js';
import { parseObjectSchema, validateState, type ObjectSchema } from './schema.js';
import { parseGameState, type GameState } from './value.js';

export type ReadonlyStateValue =
	null | boolean | number | string | readonly ReadonlyStateValue[] | ReadonlyGameState;
export interface ReadonlyGameState {
	readonly [key: string]: ReadonlyStateValue;
}
type ReadonlySlot =
	{ readonly exists: false } | { readonly exists: true; readonly value: ReadonlyStateValue };
export interface RuleContext {
	readonly before: ReadonlyGameState;
	readonly after: ReadonlyGameState;
	readonly changes: readonly {
		readonly path: readonly string[];
		readonly before: ReadonlySlot;
		readonly after: ReadonlySlot;
	}[];
	readonly action: { readonly name: string; readonly args: ReadonlyGameState };
}
export type FilterDecision = { allow: true } | { allow: false; reason: string };
export interface FilterExecutor {
	evaluate(context: RuleContext): FilterDecision;
}
export interface IncludedHookExecutor {
	execute(context: RuleContext): void;
}
/** Trusted integration seam: stage 4 will aggregate sandboxed Filter/Hook conditions here. */
export type TransactionValidator = (context: RuleContext) => void;
export class TransactionFailure extends Error {
	constructor(
		public readonly phase: 'filter' | 'hook' | 'workspace',
		public readonly ruleId: string | null,
		public readonly code: string
	) {
		super(`${phase}${ruleId ? ` (${ruleId})` : ''}: ${code}`);
		this.name = 'TransactionFailure';
	}
}
function freeze<T>(value: T): T {
	if (value !== null && typeof value === 'object') {
		Object.values(value).forEach(freeze);
		Object.freeze(value);
	}
	return value;
}

/** No persistence, AI work or creator-code execution occurs inside this detached unit. */
export function createWorkspace(schemaInput: unknown, initial: unknown) {
	const schema: ObjectSchema = parseObjectSchema(schemaInput);
	const before = validateState(schema, initial, 'load');
	let current = parseGameState(before);
	let status: 'open' | 'failed' | 'finished' = 'open';
	function open() {
		if (status !== 'open') throw new TransactionFailure('workspace', null, status);
	}
	function attempt<T>(operation: () => T): T {
		open();
		try {
			return operation();
		} catch (error) {
			status = 'failed';
			throw error;
		}
	}
	return {
		read: () => {
			open();
			return parseGameState(current);
		},
		replace(next: unknown) {
			return attempt(() => {
				current = validateState(schema, next, 'commit');
				return parseGameState(current);
			});
		},
		step(
			actionInput: Action,
			argumentsSchema: unknown,
			operation: (state: GameState, args: GameState) => unknown
		) {
			return attempt(() => {
				const action = parseAction(actionInput);
				const args = validateState(argumentsSchema, action.args, 'arguments');
				current = validateState(schema, operation(parseGameState(current), args), 'commit');
				return parseGameState(current);
			});
		},
		finish(action: Action, validate?: TransactionValidator) {
			return attempt(() => {
				const state = validateState(schema, current, 'commit');
				const changes = diffState(before, state);
				const parsedAction = parseAction(action);
				const result: unknown = validate?.(
					freeze({
						before: parseGameState(before),
						after: parseGameState(state),
						changes: structuredClone(changes),
						action: parsedAction
					})
				);
				if (result !== undefined)
					throw new TransactionFailure('workspace', null, 'invalid-validator-result');
				status = 'finished';
				return { state, changes };
			});
		},
		abort() {
			status = 'failed';
		}
	};
}
