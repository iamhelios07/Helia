import type ts from 'typescript';

import type { Game } from './model.js';

import { argumentSchemaCompiler } from './argument-schema.js';
import { isTypeOnlyModule } from './module-syntax.js';
import { generateStateTypes } from './state/schema.js';
import { parseGameUI, UI_LIMITS, type GameUI } from './ui/runtime/model.js';

export type CodeLanguage = 'typescript' | 'tsx' | 'css';
/** The single global creator stylesheet, loaded next to the project entry. */
export const GAME_STYLESHEET = 'style.css';
export interface CodeProject {
	version: 1;
	entry: string;
	files: Record<string, { language: CodeLanguage; source: string }>;
	folders?: string[];
	presentation?: Pick<GameUI, 'layout' | 'chatDock' | 'chatRatio' | 'chatStyle'>;
}
export class CodeProjectError extends Error {
	constructor(
		message: string,
		public file: string,
		public line = 1,
		public column = 1
	) {
		super(message);
	}
}
export function validCodePath(value: unknown, folder = false): value is string {
	return (
		value === GAME_STYLESHEET ||
		(typeof value === 'string' &&
			/^[\w][\w./-]{0,127}$/.test(value) &&
			value
				.split('/')
				.every(
					(part) => part && !['.', '..', '__proto__', 'constructor', 'prototype'].includes(part)
				) &&
			(folder || /\.(?:ts|tsx)$/.test(value)))
	);
}
export function parseCodeProject(input: unknown): CodeProject {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw Error('코드 프로젝트의 형식이 올바르지 않아요.');
	}
	const value = input as Record<string, unknown>;
	if (
		value.version !== 1 ||
		!validCodePath(value.entry, true) ||
		!/\.(?:js|jsx|ts|tsx)$/.test(String(value.entry)) ||
		!value.files ||
		typeof value.files !== 'object' ||
		Array.isArray(value.files)
	) {
		throw Error('코드 프로젝트의 진입 파일과 소스 파일을 확인해주세요.');
	}
	const { files, entry: resolvedEntry } = parseFiles(
		value.files as Record<string, unknown>,
		value.entry
	);
	const folders = parseFolders(value.folders);
	const paths = [...Object.keys(files), ...(folders ?? [])];
	for (const path of Object.keys(files)) {
		if (
			paths.some((other) => other !== path && other.startsWith(path + '/')) ||
			folders?.includes(path)
		) {
			throw Error('파일과 폴더의 경로가 겹쳐요.');
		}
	}
	const presentation = parsePresentation(value.presentation);
	return {
		version: 1,
		entry: resolvedEntry,
		files,
		...(folders ? { folders } : {}),
		...(presentation ? { presentation } : {})
	};
}

/** Projects authored before TypeScript-only support move to typed extensions when loaded. */
function typedPath(path: string): string {
	return path.replace(/\.jsx$/, '.tsx').replace(/\.js$/, '.ts');
}

/** Relative imports keep resolving once the extension is dropped and the target becomes typed. */
function retargetImports(source: string): string {
	return source.replace(
		/(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\.jsx?\2/g,
		(_match, lead: string, quote: string, request: string) => `${lead}${quote}${request}${quote}`
	);
}

/** Validates one raw project entry and returns its source, language and final path. */
function parseFileEntry(
	files: CodeProject['files'],
	path: string,
	raw: unknown
): [{ language: CodeLanguage; source: string }, string, string] {
	if (!validCodePath(path, true) || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw Error('사용할 수 없는 코드 파일 경로예요.');
	}
	const file = raw as Record<string, unknown>;
	const language = String(file.language);
	if (
		!['javascript', 'typescript', 'jsx', 'tsx', 'css'].includes(language) ||
		typeof file.source !== 'string'
	) {
		throw Error('코드 파일의 언어와 내용을 확인해주세요.');
	}
	const target = typedPath(path);
	if (!validCodePath(target) || Object.hasOwn(files, target)) {
		throw Error('사용할 수 없는 코드 파일 경로예요.');
	}
	return [file as { language: CodeLanguage; source: string }, language, target];
}

function parseFiles(rawFiles: Record<string, unknown>, entry: string) {
	const files: CodeProject['files'] = {};
	let size = 0;
	for (const [path, raw] of Object.entries(rawFiles)) {
		const [file, language, target] = parseFileEntry(files, path, raw);
		if (language === 'css') {
			size += stylesheetSize(path, file.source);
			files[target] = { language: 'css', source: file.source };
			continue;
		}
		if (path === GAME_STYLESHEET) {
			throw Error('style.css는 스타일시트 전용이에요.');
		}
		size += new TextEncoder().encode(file.source).length;
		files[target] = {
			language: language === 'jsx' || language === 'tsx' ? 'tsx' : 'typescript',
			source: retargetImports(file.source)
		};
	}
	if (Object.keys(files).length > 64 || size > 512 * 1024) {
		throw Error('코드 프로젝트는 진입 파일을 포함해 64개 파일, 512 KiB까지 지원해요.');
	}
	const resolvedEntry = typedPath(entry);
	if (!Object.hasOwn(files, resolvedEntry)) {
		throw Error('코드 프로젝트는 진입 파일을 포함해 64개 파일, 512 KiB까지 지원해요.');
	}

	return { files, entry: resolvedEntry };
}

/** style.css is the only stylesheet, reserved for CSS, and capped on its own. */
function stylesheetSize(path: string, source: string): number {
	if (path !== GAME_STYLESHEET) {
		throw Error('스타일시트는 style.css 하나만 지원해요.');
	}
	const size = new TextEncoder().encode(source).length;
	if (size > UI_LIMITS.styleBytes) {
		throw Error('스타일시트가 너무 커요.');
	}
	return size;
}

function parseFolders(raw: unknown) {
	let folders: string[] | undefined;
	if (raw !== undefined) {
		if (!Array.isArray(raw) || raw.length > 128 || raw.some((path) => !validCodePath(path, true))) {
			throw Error('코드 폴더 경로를 확인해주세요.');
		}
		folders = [...new Set(raw as string[])];
	}

	return folders;
}
function parsePresentation(raw: unknown) {
	let presentation: CodeProject['presentation'];
	if (raw !== undefined) {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			throw Error('화면 배치 설정을 확인해주세요.');
		}
		if (
			Object.keys(raw).some(
				(key) => !['layout', 'chatDock', 'chatRatio', 'chatStyle'].includes(key)
			)
		) {
			throw Error('지원하지 않는 화면 배치 설정이에요.');
		}
		const ui = parseGameUI({
			version: 1,
			entry: 'main.tsx',
			modules: { 'main.tsx': { language: 'tsx', source: '' } },
			...raw
		});
		presentation = pickPresentation(ui);
	}

	return presentation;
}
/** Existing applied content becomes a source project without executing it. */
export function createCodeProject(game: Pick<Game, 'scripts' | 'ui' | 'code'>): CodeProject {
	if (game.code) {
		return parseCodeProject(game.code);
	}
	const files: CodeProject['files'] = {};
	const imports: string[] = [];
	const scripts = Object.entries(game.scripts)
		.sort(([a], [b]) => comparePaths(a, b))
		.map(([, script]) => script);
	for (const [index, script] of scripts.entries()) {
		const path = `logic/part-${index + 1}.ts`;
		files[path] = {
			language: 'typescript',
			source: `'use logic';\n${script.source}\n`
		};
		imports.push(`import './${path}';`);
	}
	let presentation: CodeProject['presentation'];
	if (game.ui) {
		presentation = convertLegacyUI(game.ui, files, imports);
	}
	files['main.ts'] = {
		language: 'typescript',
		source: (imports.join('\n') || 'export {};') + '\n'
	};
	return parseCodeProject({
		version: 1,
		entry: 'main.ts',
		files,
		...(presentation ? { presentation } : {})
	});
}

function pickPresentation(ui: GameUI): CodeProject['presentation'] {
	const { layout, chatDock, chatRatio, chatStyle } = ui;
	return {
		...(layout ? { layout } : {}),
		...(chatDock ? { chatDock } : {}),
		...(chatRatio !== undefined ? { chatRatio } : {}),
		...(chatStyle ? { chatStyle } : {})
	};
}
function convertLegacyUI(ui: GameUI, files: CodeProject['files'], imports: string[]) {
	const pathFor = (id: string, language: string) => {
		if (/\.(js|ts|jsx|tsx)$/.test(id)) {
			return 'ui/' + typedPath(id);
		}
		const typed = language === 'jsx' || language === 'tsx' ? 'tsx' : 'ts';
		return 'ui/' + id + '.' + typed;
	};
	for (const [id, file] of Object.entries(ui.modules)) {
		files[pathFor(id, file.language)] = {
			language: file.language === 'tsx' ? 'tsx' : 'typescript',
			source: `'use ui';\n${file.source}`
		};
	}
	let start = 'ui/start-entry.ts';
	while (Object.hasOwn(files, start)) {
		start = start.replace('.ts', '-next.ts');
	}
	const entry = pathFor(ui.entry, ui.modules[ui.entry].language).slice(3);
	files[start] = {
		language: 'typescript',
		source: `'use ui';\nimport * as entry from './${entry}';\nimport { onDispose } from '@helia/ui';\nconst initialize: unknown = Reflect.get(entry, 'default');\nif (typeof initialize === 'function') {\n const dispose = initialize(helia);\n if (typeof dispose === 'function') onDispose(dispose);\n}\n`
	};
	imports.push(`import './${start}';`);
	return pickPresentation(ui);
}
/** Resolve the single authoring entry into two isolated runtime graphs. Never evaluate source here. */
export async function compileCodeProject(
	input: CodeProject,
	schema?: unknown
): Promise<Pick<Game, 'scripts' | 'ui'>> {
	const project = parseCodeProject(input);
	const { default: compiler } = await import('typescript');
	return new ProjectCompiler(compiler, project).compile(schema);
}
type RuntimeTarget = 'logic' | 'ui';
interface ModuleGraph {
	target: RuntimeTarget;
	modules: CodeProject['files'];
	dependencies: Record<string, Record<string, string>>;
	omitted: Map<string, Set<string>>;
}
class ProjectCompiler {
	readonly trees = new Map<string, ts.SourceFile>();
	readonly domains = new Map<string, RuntimeTarget | undefined>();
	readonly uiRoots = new Set<string>();
	legacy = false;
	constructor(
		readonly compiler: typeof ts,
		readonly project: CodeProject
	) {}
	error(message: string, file: string, node?: ts.Node): never {
		const location = node?.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
		throw new CodeProjectError(
			message,
			file,
			(location?.line ?? 0) + 1,
			(location?.character ?? 0) + 1
		);
	}

	resolve(from: string, specifier: string, node?: ts.Node): string {
		if (!specifier.startsWith('.')) {
			return this.error('프로젝트에 포함된 상대 경로만 불러올 수 있어요.', from, node);
		}
		const parts = from.split('/').slice(0, -1);
		for (const part of specifier.split('/')) {
			if (part === '.' || !part) {
				continue;
			}
			if (part === '..') {
				if (!parts.length) {
					this.error('프로젝트 밖의 파일은 불러올 수 없어요.', from, node);
				}
				parts.pop();
			} else {
				parts.push(part);
			}
		}
		const path = parts.join('/');
		const found = [
			path,
			...['.ts', '.tsx', '/index.ts', '/index.tsx'].map((ext) => path + ext)
		].find((id) => Object.hasOwn(this.project.files, id));
		return found ?? this.error(`파일을 찾을 수 없어요: ${specifier}`, from, node);
	}

	sourceFile(path: string) {
		const previous = this.trees.get(path);
		if (previous) {
			return previous;
		}
		const file = this.project.files[path];
		const tree = this.compiler.createSourceFile(
			path,
			file.source,
			this.compiler.ScriptTarget.ES2022,
			true,
			scriptKind(this.compiler, file.language)
		);
		const diagnostics = this.compiler.transpileModule(file.source, {
			fileName: path,
			reportDiagnostics: true,
			compilerOptions: {
				target: this.compiler.ScriptTarget.ES2022,
				module: this.compiler.ModuleKind.CommonJS,
				jsx: this.compiler.JsxEmit.React
			}
		}).diagnostics;
		const failure = diagnostics?.find(
			(item) => item.category === this.compiler.DiagnosticCategory.Error
		);
		if (failure) {
			const p = tree.getLineAndCharacterOfPosition(failure.start ?? 0);
			throw new CodeProjectError(
				this.compiler.flattenDiagnosticMessageText(failure.messageText, '\n'),
				path,
				p.line + 1,
				p.character + 1
			);
		}
		this.trees.set(path, tree);
		return tree;
	}

	isLegacyStatement(statement: ts.Statement) {
		return (
			this.compiler.isEmptyStatement(statement) ||
			(this.compiler.isExportDeclaration(statement) &&
				!statement.isTypeOnly &&
				statement.exportClause &&
				this.compiler.isNamedExports(statement.exportClause) &&
				statement.exportClause.elements.every(
					(item) =>
						item.propertyName?.text === 'default' && ['logic', 'ui'].includes(item.name.text)
				))
		);
	}
	readTargets() {
		const targets: Partial<Record<RuntimeTarget, string>> = {};
		const main = this.sourceFile(this.project.entry);
		const legacy = main.statements.every((statement) => this.isLegacyStatement(statement));
		if (legacy) {
			for (const statement of main.statements) {
				this.readLegacyExport(statement, targets);
			}
		}
		return { targets, legacy };
	}
	readLegacyExport(statement: ts.Statement, targets: Partial<Record<RuntimeTarget, string>>) {
		if (this.compiler.isEmptyStatement(statement)) {
			return;
		}
		if (
			!this.compiler.isExportDeclaration(statement) ||
			statement.isTypeOnly ||
			!statement.exportClause ||
			!this.compiler.isNamedExports(statement.exportClause)
		) {
			this.error(
				'진입 파일에서는 logic과 ui를 이름으로 다시 내보내세요.',
				this.project.entry,
				statement
			);
		}
		if (!statement.exportClause.elements.length && !statement.moduleSpecifier) {
			return;
		}
		if (!statement.moduleSpecifier || !this.compiler.isStringLiteral(statement.moduleSpecifier)) {
			this.error('진입 파일의 내보내기 경로를 확인해주세요.', this.project.entry, statement);
		}
		for (const entry of statement.exportClause.elements) {
			const name = entry.name.text;
			if (
				!['logic', 'ui'].includes(name) ||
				entry.propertyName?.text !== 'default' ||
				targets[name as 'logic' | 'ui']
			) {
				this.error(
					'logic과 ui는 각각 한 번, 모듈의 default로 연결해야 해요.',
					this.project.entry,
					entry
				);
			}
			targets[name as 'logic' | 'ui'] = this.resolve(
				this.project.entry,
				statement.moduleSpecifier.text,
				statement
			);
		}
	}
	directive(statement: ts.Statement) {
		if (
			!this.compiler.isExpressionStatement(statement) ||
			!this.compiler.isStringLiteral(statement.expression)
		) {
			return undefined;
		}
		return statement.expression.text;
	}
	domain(path: string) {
		if (this.domains.has(path)) {
			return this.domains.get(path);
		}
		let result: 'logic' | 'ui' | undefined;
		for (const statement of this.sourceFile(path).statements) {
			const directive = this.directive(statement);
			if (directive === undefined) {
				break;
			}
			if (directive !== 'use ui' && directive !== 'use logic') {
				continue;
			}
			const next = directive === 'use ui' ? 'ui' : 'logic';
			if (result && result !== next) {
				this.error('한 모듈에는 하나의 실행 영역만 지정해주세요.', path, statement);
			}
			result = next;
		}
		this.domains.set(path, result);
		return result;
	}

	graph(entry: string, target: RuntimeTarget) {
		const result: ModuleGraph = { target, modules: {}, dependencies: {}, omitted: new Map() };
		this.collect(entry, result);
		return result;
	}
	collect(path: string, graph: ModuleGraph) {
		if (Object.hasOwn(graph.modules, path)) {
			return;
		}
		if (this.legacy && path === this.project.entry) {
			this.error('진입 파일을 실행 모듈에서 가져올 수 없어요.', path);
		}
		const scope = this.domain(path) ?? (path === this.project.entry ? 'logic' : undefined);
		if (scope && scope !== graph.target) {
			this.error(
				'서로 다른 실행 영역의 모듈 값을 가져올 수 없어요. UI에서는 Action 요청과 읽기 전용 상태 API를 사용해주세요.',
				path
			);
		}
		const file = this.project.files[path];
		if (graph.target === 'logic' && file.language === 'tsx') {
			this.error(
				"화면 모듈 맨 위에 'use ui';를 지정해주세요. 로직에서는 JSX를 실행할 수 없어요.",
				path
			);
		}
		graph.modules[path] = file;
		graph.dependencies[path] = {};
		this.visit(this.sourceFile(path), path, graph);
	}
	visit(node: ts.Node, path: string, graph: ModuleGraph) {
		if (
			(this.compiler.isImportDeclaration(node) || this.compiler.isExportDeclaration(node)) &&
			node.moduleSpecifier
		) {
			if (isTypeOnlyModule(this.compiler, node)) {
				return;
			}
			this.importModule(node, path, graph);
		}
		this.validateLoading(node, path);
		this.validateAwait(node, path);
		this.compiler.forEachChild(node, (child) => this.visit(child, path, graph));
	}
	importModule(
		node: ts.ImportDeclaration | ts.ExportDeclaration,
		path: string,
		graph: ModuleGraph
	) {
		if (!node.moduleSpecifier || !this.compiler.isStringLiteral(node.moduleSpecifier)) {
			this.error('정적인 모듈 경로가 필요해요.', path, node);
		}
		const specifier = node.moduleSpecifier.text;
		if (graph.target === 'ui' && ['preact', 'preact/hooks', '@helia/ui'].includes(specifier)) {
			graph.dependencies[path][specifier] = specifier;
			return;
		}
		const id = this.resolve(path, specifier, node);
		if (graph.target === 'logic' && this.domain(id) === 'ui') {
			this.importUI(node, { path, specifier, id }, graph);
			return;
		}
		graph.dependencies[path][specifier] = id;
		this.collect(id, graph);
	}
	importUI(
		node: ts.ImportDeclaration | ts.ExportDeclaration,
		imported: { path: string; specifier: string; id: string },
		graph: ModuleGraph
	) {
		if (!this.compiler.isImportDeclaration(node) || node.importClause) {
			this.error(
				"UI 모듈은 import './ui';처럼 실행 목적으로 연결해주세요. 로직에서 UI의 값을 가져올 수 없어요.",
				imported.path,
				node
			);
		}
		this.uiRoots.add(imported.id);
		if (!graph.omitted.has(imported.path)) {
			graph.omitted.set(imported.path, new Set());
		}
		graph.omitted.get(imported.path)!.add(imported.specifier);
	}
	validateLoading(node: ts.Node, path: string) {
		if (
			this.compiler.isMetaProperty(node) ||
			this.compiler.isImportEqualsDeclaration(node) ||
			this.dynamicCall(node)
		) {
			this.error('동적 모듈 로딩은 지원하지 않아요.', path, node);
		}
	}
	dynamicCall(node: ts.Node) {
		return (
			this.compiler.isCallExpression(node) &&
			(node.expression.kind === this.compiler.SyntaxKind.ImportKeyword ||
				(this.compiler.isIdentifier(node.expression) && node.expression.text === 'require'))
		);
	}
	validateAwait(node: ts.Node, path: string) {
		if (
			!this.compiler.isAwaitExpression(node) &&
			!(this.compiler.isForOfStatement(node) && node.awaitModifier)
		) {
			return;
		}
		let parent = node.parent;
		while (parent && !this.compiler.isFunctionLike(parent)) {
			parent = parent.parent;
		}
		if (!parent) {
			this.error('모듈 최상위의 await는 지원하지 않아요.', path, node);
		}
	}
	buildLogic(entry: string, schema?: unknown) {
		const scripts: Game['scripts'] = {};
		const { modules, dependencies, omitted } = this.graph(entry, 'logic');
		const argumentsFor = argumentSchemaCompiler(
			this.compiler,
			this.project.files,
			this.error.bind(this),
			schema === undefined ? undefined : generateStateTypes(schema)
		);
		const factories = Object.entries(modules)
			.map(([path]) => {
				const output = this.compiler.transpileModule(argumentsFor(path), {
					fileName: path,
					compilerOptions: {
						target: this.compiler.ScriptTarget.ES2022,
						module: this.compiler.ModuleKind.CommonJS,
						esModuleInterop: true
					},
					transformers: {
						before: [
							() => (tree) =>
								this.compiler.factory.updateSourceFile(
									tree,
									tree.statements.filter(
										(statement) =>
											!(
												this.compiler.isImportDeclaration(statement) &&
												this.compiler.isStringLiteral(statement.moduleSpecifier) &&
												omitted.get(path)?.has(statement.moduleSpecifier.text)
											)
									)
								)
						]
					}
				}).outputText;
				return `${JSON.stringify(path)}:function(module,exports,require){\n${output}\n}`;
			})
			.join(',');
		scripts['project'] = {
			language: 'javascript',
			source: `(function(factories,deps,entry){const cache=Object.create(null);function load(id){if(Object.hasOwn(cache,id))return cache[id].exports;const module={exports:{}};cache[id]=module;factories[id](module,module.exports,function(name){const target=deps[id][name];if(!target)throw Error('Unknown module');return load(target);});return module.exports;}const entryModule=load(entry);${this.legacy ? "const register=entryModule.default;if(typeof register!=='function')throw Error('Logic default must be a function');const result=register();if(result&&typeof result.then==='function')throw Error('Logic registration must be synchronous');" : ''}})({${factories}},${JSON.stringify(dependencies)},${JSON.stringify(entry)});`
		};
		if (new TextEncoder().encode(scripts.project.source).length > 512 * 1024) {
			this.error('컴파일된 로직이 실행 한도 512 KiB를 넘었어요.', entry);
		}
		return scripts;
	}
	buildUI(entry: string | undefined) {
		let ui: GameUI | undefined;
		if (entry) {
			const { modules } = this.graph(entry, 'ui');
			if (this.legacy) {
				ui = parseGameUI({
					version: 1,
					entry,
					modules,
					...this.withStylesheet(),
					...this.project.presentation
				});
			} else {
				this.uiRoots.add(entry);
			}
		}
		if (this.uiRoots.size) {
			const modules: CodeProject['files'] = {};
			for (const root of this.uiRoots) {
				Object.assign(modules, this.graph(root, 'ui').modules);
			}
			const startup = [...this.uiRoots].map((root) => `import './${root}';`);
			if (ui) {
				// A legacy UI target can coexist with newly imported UI modules.
				Object.assign(modules, ui.modules);
				startup.push(
					`import * as legacyEntry from './${ui.entry}';\nconst initialize: unknown = Reflect.get(legacyEntry,'default');\nif(typeof initialize === 'function'){const dispose=initialize(helia);if(typeof dispose==='function')helia.onDispose(dispose);}`
				);
			}
			let entry = 'helia-ui-entry.ts';
			while (Object.hasOwn(this.project.files, entry)) {
				entry = entry.replace('.ts', '-next.ts');
			}
			modules[entry] = {
				language: 'typescript',
				source: startup.join('\n')
			};
			ui = parseGameUI({
				version: 1,
				entry,
				modules,
				...this.withStylesheet(),
				...this.project.presentation
			});
		}

		return ui;
	}
	/** The global creator stylesheet rides along with any UI, including none at all. */
	private withStylesheet(): Pick<GameUI, 'styles'> | undefined {
		const stylesheet = this.project.files[GAME_STYLESHEET];
		if (!stylesheet) {
			return undefined;
		}
		// Reuse GameUI validation so both editors and the runtime enforce the same limits.
		return { styles: parseGameUI(parseGameUIStyles(stylesheet.source)).styles };
	}

	compile(schema?: unknown) {
		const { targets, legacy } = this.readTargets();
		this.legacy = legacy;
		if (!legacy) {
			targets[this.domain(this.project.entry) ?? 'logic'] = this.project.entry;
		}
		const scripts = targets.logic ? this.buildLogic(targets.logic, schema) : {};
		const ui = this.buildUI(targets.ui);
		return { scripts, ui };
	}
}
export async function compileAuthoringGame(game: Game): Promise<Game> {
	if (!game.code) {
		return game;
	}
	const compiled = await compileCodeProject(game.code, game.schema);
	return { ...game, scripts: compiled.scripts, ui: compiled.ui };
}

function parseGameUIStyles(source: string) {
	return {
		version: 1 as const,
		entry: 'x.tsx',
		modules: { 'x.tsx': { language: 'tsx' as const, source: '' } },
		styles: source
	};
}

function comparePaths(a: string, b: string) {
	if (a === b) {
		return 0;
	}
	return a < b ? -1 : 1;
}

function scriptKind(compiler: typeof ts, language: CodeLanguage) {
	return language === 'tsx' ? compiler.ScriptKind.TSX : compiler.ScriptKind.TS;
}
