import { diffState } from '#lib/games/state/changes.js';
import { parseAction, type Action } from '#lib/games/state/model.js';
import { parseObjectSchema, validateState, type ObjectSchema } from '#lib/games/state/schema.js';
import { parseGameState, parseStateValue, type GameState } from '#lib/games/state/value.js';
import { createWorkspace } from '#lib/games/state/workspace.js';
import {
	CreatorRuntimeError,
	SANDBOX_LIMITS,
	shortName,
	type ActionRequest,
	type ActionResult,
	type RuleTrigger,
	type UIEvent
} from './protocol.js';

export interface Definition {
	name: string;
	scriptId: string;
	description?: string;
}
interface ActionDefinition extends Definition {
	arguments: ObjectSchema;
	ai: boolean;
}
interface FilterDefinition extends Definition {
	priority: number;
	actions: string[] | null;
}
interface HookDefinition extends Definition {
	priority: number;
	actions: string[] | null;
	mode: 'included' | 'independent';
}
export type RuleKind = 'action' | 'query' | 'filter' | 'hook';
export type RuleInvoker = (
	kind: RuleKind,
	definition: Definition,
	context: unknown
) => { value: unknown; events: UIEvent[] };

function definitions(value: unknown) {
	try {
		const input = parseGameState(value);
		function list(key: string): GameState[] {
			const items = input[key] ?? (key === 'queries' ? [] : undefined);
			if (!Array.isArray(items) || items.length > SANDBOX_LIMITS.ruleCount)
				throw Error('definitions');
			const rows = items.map(parseGameState);
			if (new Set(rows.map((row) => row.name)).size !== rows.length) throw Error('duplicates');
			return rows;
		}
		function base(item: GameState): Definition {
			if (
				item.description !== undefined &&
				(typeof item.description !== 'string' ||
					!item.description.trim() ||
					item.description.length > 1024)
			)
				throw Error('description');
			return {
				name: shortName(item.name),
				scriptId: shortName(item.scriptId),
				...(item.description === undefined ? {} : { description: item.description })
			};
		}
		function filter(item: GameState): FilterDefinition {
			if (
				typeof item.priority !== 'number' ||
				!Number.isInteger(item.priority) ||
				Math.abs(item.priority) > 10_000
			)
				throw Error('priority');
			if (
				item.actions !== null &&
				(!Array.isArray(item.actions) || item.actions.length > SANDBOX_LIMITS.actionCount)
			)
				throw Error('actions');
			return {
				...base(item),
				priority: item.priority,
				actions: item.actions === null ? null : item.actions.map(shortName)
			};
		}
		const actions: ActionDefinition[] = list('actions').map((item) => ({
			...base(item),
			arguments: parseObjectSchema(item.arguments),
			ai: item.ai === true
		}));
		const queries: ActionDefinition[] = list('queries').map((item) => ({
			...base(item),
			arguments: parseObjectSchema(item.arguments),
			ai: item.ai === true
		}));
		const filters = list('filters')
			.map(filter)
			.sort((a, b) => a.priority - b.priority);
		const hooks = list('hooks')
			.map((item): HookDefinition => {
				if (item.mode !== 'included' && item.mode !== 'independent') throw Error('mode');
				return { ...filter(item), mode: item.mode };
			})
			.sort((a, b) => a.priority - b.priority);
		return { actions, queries, filters, hooks };
	} catch {
		throw new CreatorRuntimeError('registration');
	}
}
function matches(rule: FilterDefinition | HookDefinition, action: Action) {
	return rule.actions === null || rule.actions.includes(action.name);
}

/** Host orchestration only. Every state proposal is validated before another step may observe it. */
export function evaluateRules(
	input: ActionRequest,
	metadata: unknown,
	invoke: RuleInvoker
): ActionResult {
	const registry = definitions(metadata);
	if (input.operation?.kind === 'catalog')
		return {
			state: input.state,
			tools: [
				...registry.actions.filter((d) => d.ai).map((d) => ({ kind: 'action' as const, ...d })),
				...registry.queries.filter((d) => d.ai).map((d) => ({ kind: 'query' as const, ...d }))
			].map((d) => ({
				kind: d.kind,
				name: d.name,
				description: d.description ?? d.name,
				arguments: d.arguments
			}))
		};
	if (input.operation?.kind === 'query') {
		const query = registry.queries.find(
			(d) => d.name === (input.operation?.kind === 'query' ? input.operation.name : '')
		);
		if (!query) throw new CreatorRuntimeError('action-not-found');
		const args = validateState(query.arguments, input.operation.args, 'arguments');
		const result = invoke('query', query, { state: input.state, args });
		if (result.events.length) throw new CreatorRuntimeError('protocol');
		return { state: input.state, value: parseStateValue(result.value) };
	}
	const workspace = createWorkspace(input.schema, input.state);
	const events: UIEvent[] = [];
	let steps = 0,
		hooks = 0;
	const active = new Set<string>();
	const context = (trigger: RuleTrigger) => ({
		...trigger,
		changes: diffState(trigger.before, trigger.after),
		state: workspace.read()
	});
	function append(next: UIEvent[]) {
		if (events.length + next.length > SANDBOX_LIMITS.eventCount)
			throw new CreatorRuntimeError('chain-limit');
		events.push(...next);
	}
	function filters(trigger: RuleTrigger) {
		for (const rule of registry.filters.filter((rule) => matches(rule, trigger.action))) {
			const result = invoke('filter', rule, { ...context(trigger), state: trigger.after });
			try {
				const decision = parseGameState(result.value);
				if (
					result.events.length ||
					Object.keys(decision).some((key) => !['allow', 'reason'].includes(key)) ||
					typeof decision.allow !== 'boolean' ||
					(decision.reason !== undefined &&
						(typeof decision.reason !== 'string' || decision.reason.length > 1024))
				)
					throw Error('decision');
				if (!decision.allow)
					throw new CreatorRuntimeError(
						'filter-rejected',
						rule.scriptId,
						rule.name,
						typeof decision.reason === 'string' ? decision.reason : null
					);
			} catch (error) {
				if (error instanceof CreatorRuntimeError) throw error;
				throw new CreatorRuntimeError('filter', rule.scriptId, rule.name);
			}
		}
	}
	function hook(rule: HookDefinition, trigger: RuleTrigger): Action[] {
		if (++hooks > SANDBOX_LIMITS.hookCount)
			throw new CreatorRuntimeError('chain-limit', rule.scriptId, rule.name);
		const result = invoke('hook', rule, context(trigger));
		append(result.events);
		try {
			if (!Array.isArray(result.value) || result.value.length > SANDBOX_LIMITS.stepCount)
				throw Error('hook-result');
			return result.value.map(parseAction);
		} catch {
			throw new CreatorRuntimeError('hook', rule.scriptId, rule.name);
		}
	}
	function included(trigger: RuleTrigger, depth: number) {
		if (!diffState(trigger.before, trigger.after).length) return;
		for (const rule of registry.hooks.filter(
			(rule) => rule.mode === 'included' && matches(rule, trigger.action)
		))
			for (const action of hook(rule, trigger)) execute(action, depth + 1);
	}
	function execute(action: Action, depth: number) {
		if (depth > SANDBOX_LIMITS.depth || ++steps > SANDBOX_LIMITS.stepCount)
			throw new CreatorRuntimeError('chain-limit', null, action.name);
		if (active.has(action.name)) throw new CreatorRuntimeError('reentry', null, action.name);
		const definition = registry.actions.find((item) => item.name === action.name);
		if (!definition) throw new CreatorRuntimeError('action-not-found', null, action.name);
		const before = workspace.read();
		active.add(action.name);
		try {
			let args: GameState;
			try {
				args = validateState(definition.arguments, action.args, 'arguments');
			} catch {
				throw new CreatorRuntimeError('arguments', definition.scriptId, action.name);
			}
			const result = invoke('action', definition, { state: before, args });
			append(result.events);
			let after: GameState;
			try {
				after = validateState(input.schema, result.value, 'commit');
			} catch {
				throw new CreatorRuntimeError('state', definition.scriptId, action.name);
			}
			filters({ before, after, action });
			workspace.replace(after);
			included({ before, after, action }, depth);
		} finally {
			active.delete(action.name);
		}
	}
	let description: string | undefined;
	try {
		if (input.operation?.kind === 'hook') {
			const hookName = input.operation.name;
			const rule = registry.hooks.find(
				(item) => item.name === hookName && item.mode === 'independent'
			);
			if (!rule) throw new CreatorRuntimeError('hook', null, input.operation.name);
			description = rule.description;
			for (const action of hook(rule, input.operation.trigger)) execute(action, 1);
		} else if (input.operation?.kind === 'proposal' || input.operation?.kind === 'validate') {
			steps++;
			const after = validateState(input.schema, input.operation.state, 'commit');
			const definition = registry.actions.find((item) => item.name === input.action.name);
			if (definition) {
				try {
					validateState(definition.arguments, input.action.args, 'arguments');
				} catch {
					throw new CreatorRuntimeError('arguments', definition.scriptId, definition.name);
				}
			}
			filters({ before: input.state, after, action: input.action });
			workspace.replace(after);
			active.add(input.action.name);
			try {
				if (input.operation.kind !== 'validate')
					included({ before: input.state, after, action: input.action }, 0);
			} finally {
				active.delete(input.action.name);
			}
		} else {
			description = registry.actions.find((item) => item.name === input.action.name)?.description;
			execute(input.action, 0);
		}
		const trigger = { before: input.state, after: workspace.read(), action: input.action };
		// Included work must also satisfy the aggregate transaction's Filters.
		if (steps > 1 || input.operation?.kind === 'hook') filters(trigger);
		const result = workspace.finish(input.action);
		const independentHooks = result.changes.length
			? registry.hooks
					.filter((rule) => rule.mode === 'independent' && matches(rule, input.action))
					.map((rule) => rule.name)
			: [];
		return {
			state: result.state,
			...(description ? { description } : {}),
			...(events.length ? { events } : {}),
			...(independentHooks.length ? { independentHooks } : {})
		};
	} catch (error) {
		workspace.abort();
		throw error;
	}
}
