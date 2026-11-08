import preactSource from 'preact?raw';
import hooksSource from 'preact/hooks?raw';
import { FRAME_BOOTSTRAP, FRAME_STYLES } from './frame-bootstrap.js';
import { parseGameUI, type GameUI } from './model.js';
import { parseResources, type GameResources } from '../../resources.js';
import { isTypeOnlyModule } from '../../module-syntax.js';

/** Compile without executing creator code in the host. Only packaged modules can be resolved. */
export async function compileGameUI(
	value: GameUI,
	token: string,
	inputResources: GameResources = {}
): Promise<string> {
	const ui = parseGameUI(value);
	const resources = parseResources(inputResources);
	const { default: ts } = await import('typescript');
	const factories: string[] = [];
	const dependencies = new Map<string, Record<string, string>>();
	function resolve(specifier: string, from: string): string {
		if (['preact', 'preact/hooks', '@helia/ui'].includes(specifier)) return specifier;
		if (!specifier.startsWith('.')) throw Error('게임 UI는 포함된 모듈만 불러올 수 있어요.');
		const parts = from.split('/').slice(0, -1);
		for (const part of specifier.split('/')) {
			if (part === '.' || !part) continue;
			if (part === '..') {
				if (!parts.length) throw Error('Invalid module path');
				parts.pop();
			} else parts.push(part);
		}
		const name = parts.join('/');
		const target = [
			name,
			...['.tsx', '.jsx', '.ts', '.js', '/index.tsx', '/index.jsx', '/index.ts', '/index.js'].map(
				(ext) => name + ext
			)
		].find((id) => Object.hasOwn(ui.modules, id));
		if (!target) throw Error('게임 UI 모듈을 찾을 수 없어요.');
		return target;
	}
	function compile(
		id: string,
		source: string,
		trusted = false,
		language?: GameUI['modules'][string]['language']
	): void {
		const extension = language === 'tsx' || language === 'jsx' ? '.' + language : '.ts';
		const fileName = trusted ? id + '.ts' : id + extension;
		const deps: Record<string, string> = {};
		if (!trusted) {
			const file = ts.createSourceFile(
				fileName,
				source,
				ts.ScriptTarget.ES2022,
				true,
				language === 'tsx'
					? ts.ScriptKind.TSX
					: language === 'jsx'
						? ts.ScriptKind.JSX
						: ts.ScriptKind.TS
			);
			function visit(node: import('typescript').Node) {
				if (isTypeOnlyModule(ts, node)) return;
				if (
					(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
					node.moduleSpecifier
				) {
					if (!ts.isStringLiteral(node.moduleSpecifier)) throw Error('Invalid module import');
					deps[node.moduleSpecifier.text] = resolve(node.moduleSpecifier.text, id);
				}
				if (
					ts.isMetaProperty(node) ||
					ts.isImportEqualsDeclaration(node) ||
					(ts.isCallExpression(node) &&
						(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
							(ts.isIdentifier(node.expression) && node.expression.text === 'require')))
				)
					throw Error('동적 모듈 로딩은 지원하지 않아요.');
				if (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier)) {
					let parent: import('typescript').Node | undefined = node.parent;
					while (parent && !ts.isFunctionLike(parent)) parent = parent.parent;
					if (!parent) throw Error('UI 모듈의 최상위 await는 지원하지 않아요.');
				}
				ts.forEachChild(node, visit);
			}
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
		if (result.diagnostics?.some((item) => item.category === ts.DiagnosticCategory.Error))
			throw Error('게임 UI 코드를 컴파일하지 못했어요.');
		dependencies.set(id, deps);
		factories.push(
			`${JSON.stringify(id)}:function(module,exports,require,__h,__Fragment){\n${result.outputText}\n}`
		);
	}
	compile('preact', preactSource, true);
	compile('preact/hooks', hooksSource, true);
	for (const [id, module] of Object.entries(ui.modules))
		compile(id, module.source, false, module.language);
	// Escape closing script tags in every source, including authored JSX/string literals.
	// Creator factories are born outside the runtime closure: free variables cannot
	// reach its private MessagePort, state listeners, or lifecycle handles.
	const resourceURLs = Object.fromEntries(
		Object.entries(resources).flatMap(([id, resource]) => [
			[id, resource.data],
			[resource.name, resource.data]
		])
	);
	const code = `((run) => {const factories={${factories.join(',')}};run(factories,${JSON.stringify(Object.fromEntries(dependencies))},${JSON.stringify(ui.entry)},${JSON.stringify(token)},JSON.parse(${JSON.stringify(JSON.stringify(resourceURLs))}));})(function(factories,dependencies,entry,token,resources){${FRAME_BOOTSTRAP}\n})`;
	return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><meta name="referrer" content="no-referrer"><style>${FRAME_STYLES}</style></head><body><div id="workbench"></div><script>${code.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
}
