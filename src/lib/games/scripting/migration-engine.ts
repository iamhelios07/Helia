import variant from '@jitl/quickjs-singlefile-browser-release-sync';
import {
	newQuickJSWASMModuleFromVariant,
	type QuickJSContext,
	type QuickJSHandle,
	type QuickJSRuntime,
	type VmCallResult
} from 'quickjs-emscripten-core';

import { MigrationFailure } from '../migration/failure.js';
import { canonical } from '../state/model.js';
import { BOOTSTRAP } from './bootstrap.js';
import { ExecutionBudget } from './budget.js';
import {
	checkCompiled,
	migrationText,
	type CompiledMigrationScript,
	type MigrationInvocation
} from './migration-protocol.js';
import { CreatorRuntimeError, SANDBOX_LIMITS } from './protocol.js';
import { definitions } from './rules.js';

const modulePromise = newQuickJSWASMModuleFromVariant(variant);
/** No web bootstrap, RPC callbacks or secret bridge are installed in this runtime. */
export async function evaluateMigration(
	compiled: CompiledMigrationScript[],
	input?: MigrationInvocation
) {
	checkCompiled(compiled);
	const module = await modulePromise;
	const runtime = module.newRuntime();
	let sandbox: MigrationSandbox | undefined;
	try {
		sandbox = new MigrationSandbox(runtime);
		return sandbox.evaluate(compiled, input);
	} finally {
		if (sandbox) {
			sandbox.dispose();
		} else {
			runtime.dispose();
		}
	}
}
class MigrationSandbox {
	private readonly budget = new ExecutionBudget();
	private readonly vm: QuickJSContext;
	private readonly handles: QuickJSHandle[] = [];
	private scriptId: string | null = null;
	private migration: string | null = null;
	constructor(private readonly runtime: QuickJSRuntime) {
		runtime.setMemoryLimit(SANDBOX_LIMITS.memoryBytes);
		runtime.setMaxStackSize(SANDBOX_LIMITS.stackBytes);
		runtime.setInterruptHandler(this.budget.expired);
		runtime.removeModuleLoader();
		this.vm = runtime.newContext();
	}
	private keep(result: VmCallResult<QuickJSHandle>) {
		if (result.error) {
			result.error.dispose();
			throw this.failure(this.budget.expired() ? 'timeout' : 'exception');
		}
		if (this.budget.expired()) {
			result.value.dispose();
			throw this.failure('timeout');
		}
		this.handles.push(result.value);
		return result.value;
	}
	private failure(kind: MigrationFailure['kind']) {
		return new MigrationFailure(kind, { scriptId: this.scriptId, migration: this.migration });
	}
	private call(control: QuickJSHandle, method: string, args: string[] = []) {
		const fn = this.vm.getProp(control, method);
		const values = args.map((arg) => this.vm.newString(arg));
		try {
			return this.keep(this.budget.run(() => this.vm.callFunction(fn, this.vm.undefined, values)));
		} finally {
			fn.dispose();
			values.forEach((value) => value.dispose());
		}
	}
	private read(handle: QuickJSHandle): unknown {
		if (this.vm.typeof(handle) !== 'string') {
			throw this.failure('exception');
		}
		return JSON.parse(migrationText(this.vm.getString(handle)));
	}
	evaluate(compiled: CompiledMigrationScript[], input?: MigrationInvocation) {
		const control = this.keep(
			this.budget.run(() => this.vm.evalCode(BOOTSTRAP, 'helia-migration.js'))
		);
		this.call(control, 'migrationMode');
		this.register(control, compiled);
		const metadata = this.metadata(control);
		let registry;
		try {
			registry = definitions(metadata);
		} catch (error) {
			if (error instanceof CreatorRuntimeError) {
				throw this.failure('registration');
			}
			throw error;
		}
		if (!input) {
			return { kind: 'catalog' as const, migrations: registry.migrations };
		}
		this.migration = input.name;
		this.scriptId = input.scriptId;
		if (
			!registry.migrations.some((row) => row.name === input.name && row.scriptId === input.scriptId)
		) {
			throw this.failure('registration');
		}
		// Parse canonical text, including defaults, rather than preserving host insertion order.
		const context = canonical({
			previous: JSON.parse(input.previous),
			previousSchema: JSON.parse(input.previousSchema),
			migrated: JSON.parse(input.migrated),
			from: input.from
		});
		const response = this.read(this.call(control, 'invoke', ['migration', input.name, context]));
		if (!response || typeof response !== 'object' || !('ok' in response) || response.ok !== true) {
			throw this.failure('nonJson');
		}
		if (!('value' in response)) {
			throw this.failure('nonJson');
		}
		return { kind: 'state' as const, value: response.value };
	}
	private metadata(control: QuickJSHandle): unknown {
		try {
			return this.read(this.call(control, 'list'));
		} catch (error) {
			if (error instanceof MigrationFailure && error.kind === 'timeout') {
				throw error;
			}
			throw this.failure('registration');
		}
	}
	private register(control: QuickJSHandle, compiled: CompiledMigrationScript[]) {
		for (const script of compiled) {
			this.scriptId = script.id;
			this.call(control, 'beginScript', [script.id]);
			try {
				this.keep(
					this.budget.run(() =>
						this.vm.evalCode(`(function(){"use strict";\n${script.source}\n})()`, `${script.id}.js`)
					)
				);
			} catch (error) {
				if (error instanceof MigrationFailure && error.kind === 'timeout') {
					throw error;
				}
				// Registration poisons list(), even if creator code catches the original error.
				try {
					this.call(control, 'list');
				} catch {
					throw this.failure('registration');
				}
				throw error;
			}
		}
		this.scriptId = null;
	}
	dispose() {
		for (const handle of this.handles.reverse()) {
			handle.dispose();
		}
		this.vm.dispose();
		this.runtime.dispose();
	}
}
