import variant from '@jitl/quickjs-singlefile-browser-release-sync';
import {
	newQuickJSWASMModuleFromVariant,
	type QuickJSContext,
	type QuickJSHandle,
	type VmCallResult
} from 'quickjs-emscripten-core';

import { parseGameState } from '#lib/games/state/value.js';

import { argumentSchemaCompiler } from '../argument-schema.js';
import { generateStateTypes } from '../state/schema.js';
import { BOOTSTRAP } from './bootstrap.js';
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

/** Call only in a disposable worker. The interpreter has no filesystem, network or host bridge. */
export async function evaluateAction(value: ActionRequest): Promise<ActionResult> {
	const input = parseInput(value);
	const compiled = await compileScripts(input);
	// A separate WASM module, runtime and context for every invocation, including different sessions.
	const module = await newQuickJSWASMModuleFromVariant(variant);
	const runtime = module.newRuntime();
	runtime.setMemoryLimit(SANDBOX_LIMITS.memoryBytes);
	runtime.setMaxStackSize(SANDBOX_LIMITS.stackBytes);
	const deadline = performance.now() + SANDBOX_LIMITS.cpuTimeMs;
	let interrupted = false;
	runtime.setInterruptHandler(() => (interrupted ||= performance.now() >= deadline));
	runtime.removeModuleLoader();
	const vm = runtime.newContext();
	const handles: QuickJSHandle[] = [];
	const keep: KeepHandle = (result, code, scriptId = null, ruleId = null) =>
		retainResult(result, { handles, interrupted, deadline }, { code, scriptId, ruleId });
	function call(
		fn: QuickJSHandle,
		args: string[],
		code: CreatorFailureCode,
		definition?: Definition
	) {
		const values = args.map((arg) => vm.newString(arg));
		try {
			return keep(
				vm.callFunction(fn, vm.undefined, values),
				code,
				definition?.scriptId,
				definition?.name
			);
		} finally {
			values.forEach((value) => value.dispose());
		}
	}
	try {
		const control = keep(
			vm.evalCode(BOOTSTRAP, 'helia-runtime.js', { type: 'global' }),
			'unavailable'
		);
		// Capture control functions before any untrusted code can modify intrinsic objects.
		const beginScript = vm.getProp(control, 'beginScript'),
			list = vm.getProp(control, 'list'),
			invoke = vm.getProp(control, 'invoke');
		handles.push(beginScript, list, invoke);
		for (const script of compiled) {
			call(beginScript, [script.id], 'registration');
			keep(
				vm.evalCode(`(function(){"use strict";\n${script.source}\n})()`, `${script.id}.js`, {
					type: 'global'
				}),
				'script',
				script.id
			);
		}
		const metadata: unknown = JSON.parse(readString(vm, call(list, [], 'registration')));
		return parseResult(
			evaluateRules(input, metadata, (kind: RuleKind, definition: Definition, context: unknown) => {
				const response = parseGameState(
					JSON.parse(
						readString(
							vm,
							call(
								invoke,
								[kind, definition.name, JSON.stringify(context)],
								kind === 'action' || kind === 'query' ? 'execution' : kind,
								definition
							)
						)
					)
				);
				return { value: response.value, events: parseEvents(response.events) };
			}),
			input.schema
		);
	} finally {
		for (const handle of handles.reverse()) {
			handle.dispose();
		}
		vm.dispose();
		runtime.dispose();
	}
}
function readString(vm: QuickJSContext, handle: QuickJSHandle): string {
	if (vm.typeof(handle) !== 'string') {
		throw new CreatorRuntimeError('protocol');
	}
	return boundedText(vm.getString(handle));
}

async function compileScripts(input: ActionRequest): Promise<{ id: string; source: string }[]> {
	const compiled: { id: string; source: string }[] = [];
	const typed = Object.entries(input.scripts);
	const typedScripts = Object.fromEntries(
		typed.map(([, script], index) => [`script-${index}.ts`, script])
	);
	const paths = new Map(typed.map(([id], index) => [id, `script-${index}.ts`]));
	let argumentsFor: ((path: string) => string) | undefined;
	for (const [id] of Object.entries(input.scripts).sort(([a], [b]) => compareScriptIds(a, b))) {
		const { default: ts } = await import('typescript');
		argumentsFor ??= argumentSchemaCompiler(
			ts,
			typedScripts,
			(_message, file) => {
				throw new CreatorRuntimeError(
					'compile',
					typed[Number(file.match(/^script-(\d+)\.ts$/)?.[1])]?.[0] ?? id
				);
			},
			generateStateTypes(input.schema)
		);
		const output = ts.transpileModule(argumentsFor(paths.get(id)!), {
			fileName: `${id}.ts`,
			reportDiagnostics: true,
			compilerOptions: {
				target: ts.ScriptTarget.ES2022,
				module: ts.ModuleKind.ESNext,
				strict: true,
				isolatedModules: true
			}
		});
		if (output.diagnostics?.some((item) => item.category === ts.DiagnosticCategory.Error)) {
			throw new CreatorRuntimeError('compile', id);
		}
		compiled.push({ id, source: output.outputText });
	}
	return compiled;
}

function compareScriptIds(a: string, b: string): number {
	if (a < b) {
		return -1;
	}
	return a > b ? 1 : 0;
}

function retainResult(
	result: VmCallResult<QuickJSHandle>,
	{
		handles,
		interrupted,
		deadline
	}: { handles: QuickJSHandle[]; interrupted: boolean; deadline: number },
	{
		code,
		scriptId,
		ruleId
	}: { code: CreatorFailureCode; scriptId: string | null; ruleId: string | null }
) {
	if (result.error) {
		// Never dump creator-thrown values: getters and conversion hooks are untrusted too.
		result.error.dispose();
		throw new CreatorRuntimeError(interrupted ? 'timeout' : code, scriptId, ruleId);
	}
	if (interrupted || performance.now() >= deadline) {
		result.value.dispose();
		throw new CreatorRuntimeError('timeout', scriptId, ruleId);
	}
	handles.push(result.value);
	return result.value;
}

type KeepHandle = (
	result: VmCallResult<QuickJSHandle>,
	code: CreatorFailureCode,
	scriptId?: string | null,
	ruleId?: string | null
) => QuickJSHandle;
