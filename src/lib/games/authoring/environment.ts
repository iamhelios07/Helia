import type ts from 'typescript';

import { isTypeOnlyModule } from '../module-syntax.js';

type Domain = 'logic' | 'ui';
interface Module {
	file: ts.SourceFile;
	domain?: Domain;
	dependencies: string[];
}

function directive(compiler: typeof ts, file: ts.SourceFile): Domain | undefined {
	for (const statement of file.statements) {
		if (
			!compiler.isExpressionStatement(statement) ||
			!compiler.isStringLiteral(statement.expression)
		) {
			break;
		}
		if (statement.expression.text === 'use ui') {
			return 'ui';
		}
		if (statement.expression.text === 'use logic') {
			return 'logic';
		}
	}
}

function resolve(from: string, request: string, sources: Map<string, string>) {
	const parts = from.split('/').slice(0, -1);
	for (const part of request.split('/')) {
		if (part === '..') {
			parts.pop();
		} else if (part !== '.') {
			parts.push(part);
		}
	}
	const path = parts.join('/');
	return [path, path + '.ts', path + '.tsx', path + '/index.ts', path + '/index.tsx'].find(
		(candidate) => sources.has(candidate)
	);
}

function readModule(
	compiler: typeof ts,
	path: string,
	source: string,
	sources: Map<string, string>
): Module {
	const file = compiler.createSourceFile(path, source, compiler.ScriptTarget.Latest, true);
	const dependencies: string[] = [];
	let ui = path.endsWith('.tsx');
	for (const statement of file.statements) {
		if (
			(!compiler.isImportDeclaration(statement) && !compiler.isExportDeclaration(statement)) ||
			!statement.moduleSpecifier ||
			!compiler.isStringLiteral(statement.moduleSpecifier) ||
			isTypeOnlyModule(compiler, statement)
		) {
			continue;
		}
		const request = statement.moduleSpecifier.text;
		ui ||= ['@helia/ui', 'preact', 'preact/hooks'].includes(request);
		const dependency = request.startsWith('.') ? resolve(path, request, sources) : undefined;
		if (dependency) {
			dependencies.push(dependency);
		}
	}
	return { file, dependencies, domain: directive(compiler, file) ?? (ui ? 'ui' : undefined) };
}

function bindingNames(compiler: typeof ts, name: ts.BindingName): string[] {
	if (compiler.isIdentifier(name)) {
		return [name.text];
	}
	return name.elements.flatMap((item) =>
		compiler.isBindingElement(item) ? bindingNames(compiler, item.name) : []
	);
}

function bindsName(compiler: typeof ts, file: ts.SourceFile, name: string) {
	return file.statements.some((statement) => {
		if (compiler.isImportDeclaration(statement)) {
			const clause = statement.importClause;
			const bindings = clause?.namedBindings;
			if (clause?.name?.text === name) {
				return true;
			}
			if (bindings && compiler.isNamespaceImport(bindings)) {
				return bindings.name.text === name;
			}
			return (
				bindings &&
				compiler.isNamedImports(bindings) &&
				bindings.elements.some((item) => item.name.text === name)
			);
		}
		if (compiler.isVariableStatement(statement)) {
			return statement.declarationList.declarations.some((item) =>
				bindingNames(compiler, item.name).includes(name)
			);
		}
		return (
			(compiler.isFunctionDeclaration(statement) || compiler.isClassDeclaration(statement)) &&
			statement.name?.text === name
		);
	});
}

function uiBindings(compiler: typeof ts, file: ts.SourceFile, shared: boolean): string {
	let binding = '';
	if (!bindsName(compiler, file, 'helia')) {
		binding = shared
			? 'declare const helia: HeliaRuntime | HeliaUIRuntime;'
			: "import { helia } from '@helia/ui';";
	}
	if (!bindsName(compiler, file, 'fetch')) {
		binding += 'declare const fetch: never;';
	}
	return binding ? '\n;export {}; ' + binding + '\n' : '';
}

/** Append type-only bindings in worker snapshots; authored text and source positions stay intact. */
export function authoringBindings(
	compiler: typeof ts,
	sources: Map<string, string>
): Map<string, string> {
	const modules = new Map(
		[...sources].map(([path, source]) => [path, readModule(compiler, path, source, sources)])
	);
	const referenced = new Set([...modules.values()].flatMap((module) => module.dependencies));
	const domains = new Map<string, Set<Domain>>();
	function visit(path: string, domain: Domain) {
		const module = modules.get(path)!;
		if (module.domain && module.domain !== domain) {
			return;
		}
		const found = domains.get(path) ?? new Set<Domain>();
		if (found.has(domain)) {
			return;
		}
		found.add(domain);
		domains.set(path, found);
		for (const dependency of module.dependencies) {
			visit(dependency, domain);
		}
	}
	for (const [path, module] of modules) {
		if (module.domain) {
			visit(path, module.domain);
		} else if (!referenced.has(path)) {
			visit(path, 'logic');
		}
	}
	const bindings = new Map<string, string>();
	for (const [path, module] of modules) {
		const found = domains.get(path);
		if (!found?.has('ui')) {
			continue;
		}
		const binding = uiBindings(compiler, module.file, found.size > 1);
		if (binding) {
			bindings.set(path, binding);
		}
	}
	return bindings;
}
