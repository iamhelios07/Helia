import type * as TypeScript from 'typescript';

import hooksSource from 'preact/hooks?raw';
import preactSource from 'preact?raw';

import { isTypeOnlyModule } from '../../module-syntax.js';
import { parseResources, type GameResources } from '../../resources.js';
import { FRAME_BOOTSTRAP } from './frame-bootstrap.js';
import { FRAME_STYLES } from './frame-styles.js';
import { parseGameUI, type GameUI } from './model.js';

/** Compile without executing creator code in the host. Only packaged modules can be resolved. */
export async function compileGameUI(
	value: GameUI,
	token: string,
	inputResources: GameResources = {}
): Promise<string> {
	const ui = parseGameUI(value);
	const resources = parseResources(inputResources);
	const { default: ts } = await import('typescript');
	const compiler = new UICompiler(ts, ui);
	compiler.compile('preact', preactSource, true);
	compiler.compile('preact/hooks', hooksSource, true);
	for (const [id, module] of Object.entries(ui.modules)) {
		compiler.compile(id, module.source, false, module.language);
	}
	// Escape closing script tags in every source, including authored JSX/string literals.
	// Creator factories are born outside the runtime closure: free variables cannot
	// reach its private MessagePort, state listeners, or lifecycle handles.
	const resourceURLs = Object.fromEntries(
		Object.entries(resources).flatMap(([id, resource]) => [
			[id, resource.data],
			[resource.name, resource.data]
		])
	);
	const code = `((run) => {const factories={${compiler.factories.join(',')}};run(factories,${JSON.stringify(Object.fromEntries(compiler.dependencies))},${JSON.stringify(ui.entry)},${JSON.stringify(token)},JSON.parse(${JSON.stringify(JSON.stringify(resourceURLs))}));})(function(factories,dependencies,entry,token,resources){${FRAME_BOOTSTRAP}\n})`;
	return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><meta name="referrer" content="no-referrer"><style>${FRAME_STYLES}${ui.styles ? '\n' + ui.styles : ''}</style></head><body><div id="workbench"></div><script>${code.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
}

class UICompiler {
	readonly factories: string[] = [];
	readonly dependencies = new Map<string, Record<string, string>>();
	constructor(
		private readonly ts: typeof TypeScript,
		private readonly ui: GameUI
	) {}
	resolve(specifier: string, from: string): string {
		if (['preact', 'preact/hooks', '@helia/ui'].includes(specifier)) {
			return specifier;
		}
		if (!specifier.startsWith('.')) {
			throw Error('게임 UI는 포함된 모듈만 불러올 수 있어요.');
		}
		const parts = from.split('/').slice(0, -1);
		for (const part of specifier.split('/')) {
			if (part === '.' || !part) {
				continue;
			}
			if (part === '..') {
				if (!parts.length) {
					throw Error('Invalid module path');
				}
				parts.pop();
			} else {
				parts.push(part);
			}
		}
		const name = parts.join('/');
		const target = [
			name,
			...['.tsx', '.jsx', '.ts', '.js', '/index.tsx', '/index.jsx', '/index.ts', '/index.js'].map(
				(ext) => name + ext
			)
		].find((id) => Object.hasOwn(this.ui.modules, id));
		if (!target) {
			throw Error('게임 UI 모듈을 찾을 수 없어요.');
		}
		return target;
	}
	compile(
		id: string,
		source: string,
		trusted = false,
		language?: GameUI['modules'][string]['language']
	): void {
		const ts = this.ts;
		const extension = language === 'tsx' ? '.tsx' : '.ts';
		const fileName = trusted ? id + '.ts' : id + extension;
		const deps: Record<string, string> = {};
		if (!trusted) {
			const file = ts.createSourceFile(
				fileName,
				source,
				ts.ScriptTarget.ES2022,
				true,
				this.scriptKind(language)
			);
			const visit = (node: import('typescript').Node) => {
				if (isTypeOnlyModule(ts, node)) {
					return;
				}
				if (
					(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
					node.moduleSpecifier
				) {
					if (!ts.isStringLiteral(node.moduleSpecifier)) {
						throw Error('Invalid module import');
					}
					deps[node.moduleSpecifier.text] = this.resolve(node.moduleSpecifier.text, id);
				}
				this.validateStaticModuleNode(node);
				ts.forEachChild(node, visit);
			};
			visit(file);
		}
		const result = ts.transpileModule(source, {
			fileName,
			reportDiagnostics: true,
			compilerOptions: {
				target: ts.ScriptTarget.ES2022,
				module: ts.ModuleKind.CommonJS,
				jsx: ts.JsxEmit.React,
				jsxFactory: '__h',
				jsxFragmentFactory: '__Fragment',
				esModuleInterop: true,
				isolatedModules: true
			}
		});
		if (result.diagnostics?.some((item) => item.category === ts.DiagnosticCategory.Error)) {
			throw Error('게임 UI 코드를 컴파일하지 못했어요.');
		}
		this.dependencies.set(id, deps);
		this.factories.push(
			`${JSON.stringify(id)}:function(module,exports,require,__h,__Fragment){\n${result.outputText}\n}`
		);
	}
	private scriptKind(language?: GameUI['modules'][string]['language']): TypeScript.ScriptKind {
		if (language === 'tsx') {
			return this.ts.ScriptKind.TSX;
		}
		return this.ts.ScriptKind.TS;
	}
	private validateStaticModuleNode(node: TypeScript.Node): void {
		const ts = this.ts;
		if (
			ts.isMetaProperty(node) ||
			ts.isImportEqualsDeclaration(node) ||
			this.isDynamicImport(node)
		) {
			throw Error('동적 모듈 로딩은 지원하지 않아요.');
		}
		if (!ts.isAwaitExpression(node) && !(ts.isForOfStatement(node) && node.awaitModifier)) {
			return;
		}
		let parent: TypeScript.Node | undefined = node.parent;
		while (parent && !ts.isFunctionLike(parent)) {
			parent = parent.parent;
		}
		if (!parent) {
			throw Error('UI 모듈의 최상위 await는 지원하지 않아요.');
		}
	}
	private isDynamicImport(node: TypeScript.Node): boolean {
		const ts = this.ts;
		return (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === 'require'))
		);
	}
}
