import { generateStateTypes } from '../state/schema.js';
import { CreatorRuntimeError, type ActionRequest } from './protocol.js';
export async function compileScripts(
	input: Pick<ActionRequest, 'scripts' | 'schema'>
): Promise<{ id: string; source: string }[]> {
	const compiled: { id: string; source: string }[] = [];
	const typed = Object.entries(input.scripts);
	const typedScripts = Object.fromEntries(
		typed.map(([, script], index) => [`script-${index}.ts`, script])
	);
	const paths = new Map(typed.map(([id], index) => [id, `script-${index}.ts`]));
	let argumentsFor: ((path: string) => string) | undefined;
	for (const [id, script] of Object.entries(input.scripts).sort(([a], [b]) =>
		compareScriptIds(a, b)
	)) {
		if (script.compiled !== undefined) {
			compiled.push({ id, source: script.compiled });
			continue;
		}
		if (script.artifact) {
			throw new CreatorRuntimeError('input', id);
		}
		const { default: ts } = await import('typescript');
		const { argumentSchemaCompiler } = await import('../argument-schema.js');
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
