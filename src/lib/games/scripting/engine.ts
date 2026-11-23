import variant from '@jitl/quickjs-singlefile-browser-release-sync';
import {
	newQuickJSWASMModuleFromVariant,
	type QuickJSContext,
	type QuickJSRuntime,
	type QuickJSHandle,
	type VmCallResult
} from 'quickjs-emscripten-core';

import { parseGameState } from '#lib/games/state/value.js';

import { BOOTSTRAP } from './bootstrap.js';
import { ExecutionBudget } from './budget.js';
import {
	boundedText,
	CreatorRuntimeError,
	parseInput,
	parseResult,
	parseEvents,
	SANDBOX_LIMITS,
	type ActionRequest,
	type ActionResult,
	type CreatorFailureCode
} from './protocol.js';
import { evaluateRules, type Definition, type RuleKind } from './rules.js';
import { compileScripts } from './script-build.js';
import { WEB_BOOTSTRAP } from './web-bootstrap.js';
import { ScriptWebBridge } from './web-bridge.js';

export interface EvaluationOptions {
	secrets?: import('../secrets/protocol.js').SecretReadAccess;
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
}
/** Call only in a disposable worker. Network access is an explicit, permission-gated capability. */
export async function evaluateAction(
	value: ActionRequest,
	options: EvaluationOptions = {}
): Promise<ActionResult> {
	const input = parseInput(value);
	const compiled = await compileScripts(input);
	const module = await newQuickJSWASMModuleFromVariant(variant);
	const sandbox = new ActionSandbox(module.newRuntime(), options);
	try {
		return parseResult(await sandbox.evaluate(input, compiled), input.schema);
	} finally {
		sandbox.dispose();
	}
}
class ActionSandbox {
	private readonly budget = new ExecutionBudget();
	private readonly vm: QuickJSContext;
	private readonly web: ScriptWebBridge;
	private readonly abort = new AbortController();
	private readonly handles: QuickJSHandle[] = [];
	constructor(
		private runtime: QuickJSRuntime,
		options: EvaluationOptions
	) {
		runtime.setMemoryLimit(SANDBOX_LIMITS.memoryBytes);
		runtime.setMaxStackSize(SANDBOX_LIMITS.stackBytes);
		runtime.setInterruptHandler(this.budget.expired);
		runtime.removeModuleLoader();
		this.vm = runtime.newContext();
		const signal = AbortSignal.any([
			this.abort.signal,
			...(options.signal ? [options.signal] : [])
		]);
		this.web = new ScriptWebBridge(
			this.vm,
			async (input, init) => {
				if (!options.fetch) {
					throw new TypeError('Fetch unavailable');
				}
				const request = new Request(input, init);
				return options.fetch(request, { signal: AbortSignal.any([signal, request.signal]) });
			},
			this.budget,
			options.secrets
		);
	}
	private keep = (
		result: VmCallResult<QuickJSHandle>,
		code: CreatorFailureCode,
		definition?: Definition
	) =>
		retainResult(
			result,
			{ handles: this.handles, budget: this.budget },
			{ code, scriptId: definition?.scriptId ?? null, ruleId: definition?.name ?? null }
		);
	private call(
		fn: QuickJSHandle,
		args: string[],
		code: CreatorFailureCode,
		definition?: Definition
	) {
		const values = args.map((arg) => this.vm.newString(arg));
		try {
			return this.keep(
				this.budget.run(() => this.vm.callFunction(fn, this.vm.undefined, values)),
				code,
				definition
			);
		} finally {
			values.forEach((value) => value.dispose());
		}
	}
	async evaluate(input: ActionRequest, compiled: { id: string; source: string }[]) {
		const control = this.keep(
			this.budget.run(() => this.vm.evalCode(BOOTSTRAP, 'helia-runtime.js', { type: 'global' })),
			'unavailable'
		);
		const begin = this.vm.getProp(control, 'beginScript'),
			list = this.vm.getProp(control, 'list'),
			invoke = this.vm.getProp(control, 'invoke'),
			install = this.vm.getProp(control, 'installWeb');
		this.handles.push(begin, list, invoke, install);
		const factory = this.keep(
			this.budget.run(() => this.vm.evalCode(WEB_BOOTSTRAP, 'helia-web.js', { type: 'global' })),
			'unavailable'
		);
		this.keep(
			this.budget.run(() =>
				this.vm.callFunction(install, this.vm.undefined, factory, ...this.web.callbacks)
			),
			'unavailable'
		);
		for (const script of compiled) {
			this.call(begin, [script.id], 'registration');
			this.keep(
				this.budget.run(() =>
					this.vm.evalCode(`(function(){"use strict";\n${script.source}\n})()`, `${script.id}.js`, {
						type: 'global'
					})
				),
				'script',
				{ name: '', scriptId: script.id }
			);
		}
		const metadata: unknown = JSON.parse(readString(this.vm, this.call(list, [], 'registration')));
		return evaluateRules(input, metadata, (kind, definition, context) =>
			this.invoke(invoke, kind, definition, context)
		);
	}
	private async invoke(
		fn: QuickJSHandle,
		kind: RuleKind,
		definition: Definition,
		context: unknown
	) {
		try {
			let result = this.call(
				fn,
				[kind, definition.name, JSON.stringify(context)],
				kind === 'action' || kind === 'query' ? 'execution' : kind,
				definition
			);
			if (kind === 'action') {
				result = await this.web.resolve(result, this.runtime);
				this.handles.push(result);
			}
			const response = parseGameState(JSON.parse(readString(this.vm, result)));
			return { value: response.value, events: parseEvents(response.events) };
		} catch (error) {
			if (error instanceof CreatorRuntimeError && !error.scriptId) {
				throw new CreatorRuntimeError(error.code, definition.scriptId, definition.name);
			}
			throw error;
		}
	}
	dispose() {
		this.abort.abort();
		this.web.dispose();
		for (const handle of this.handles.reverse()) {
			handle.dispose();
		}
		this.vm.dispose();
		this.runtime.dispose();
	}
}
function readString(vm: QuickJSContext, handle: QuickJSHandle): string {
	if (vm.typeof(handle) !== 'string') {
		throw new CreatorRuntimeError('protocol');
	}
	return boundedText(vm.getString(handle));
}

function retainResult(
	result: VmCallResult<QuickJSHandle>,
	{ handles, budget }: { handles: QuickJSHandle[]; budget: ExecutionBudget },
	{
		code,
		scriptId,
		ruleId
	}: { code: CreatorFailureCode; scriptId: string | null; ruleId: string | null }
) {
	if (result.error) {
		result.error.dispose();
		throw new CreatorRuntimeError(budget.expired() ? 'timeout' : code, scriptId, ruleId);
	}
	if (budget.expired()) {
		result.value.dispose();
		throw new CreatorRuntimeError('timeout', scriptId, ruleId);
	}
	handles.push(result.value);
	return result.value;
}
