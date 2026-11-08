import type ts from 'typescript';
import type { Game } from './model.js';
import { parseGameUI, type GameUI } from './ui/runtime/model.js';

export type CodeLanguage = 'javascript' | 'typescript' | 'jsx' | 'tsx';
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
		typeof value === 'string' &&
		/^[\w][\w./-]{0,127}$/.test(value) &&
		value
			.split('/')
			.every(
				(part) => part && !['.', '..', '__proto__', 'constructor', 'prototype'].includes(part)
			) &&
		(folder || /\.(?:js|ts|jsx|tsx)$/.test(value))
	);
}
export function parseCodeProject(input: unknown): CodeProject {
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw Error('코드 프로젝트의 형식이 올바르지 않아요.');
	const value = input as Record<string, unknown>;
	if (
		value.version !== 1 ||
		!validCodePath(value.entry) ||
		!value.files ||
		typeof value.files !== 'object' ||
		Array.isArray(value.files)
	)
		throw Error('코드 프로젝트의 진입 파일과 소스 파일을 확인해주세요.');
	const files: CodeProject['files'] = {};
	let size = 0;
	for (const [path, raw] of Object.entries(value.files)) {
		if (!validCodePath(path) || !raw || typeof raw !== 'object' || Array.isArray(raw))
			throw Error('사용할 수 없는 코드 파일 경로예요.');
		const file = raw as Record<string, unknown>;
		if (
			!['javascript', 'typescript', 'jsx', 'tsx'].includes(String(file.language)) ||
			typeof file.source !== 'string'
		)
			throw Error('코드 파일의 언어와 내용을 확인해주세요.');
		size += new TextEncoder().encode(file.source).length;
		files[path] = { language: file.language as CodeLanguage, source: file.source };
	}
	if (Object.keys(files).length > 64 || size > 512 * 1024 || !Object.hasOwn(files, value.entry))
		throw Error('코드 프로젝트는 진입 파일을 포함해 64개 파일, 512 KiB까지 지원해요.');
	let folders: string[] | undefined;
	if (value.folders !== undefined) {
		if (
			!Array.isArray(value.folders) ||
			value.folders.length > 128 ||
			value.folders.some((path) => !validCodePath(path, true))
		)
			throw Error('코드 폴더 경로를 확인해주세요.');
		folders = [...new Set(value.folders as string[])];
	}
	const paths = [...Object.keys(files), ...(folders ?? [])];
	for (const path of Object.keys(files))
		if (
			paths.some((other) => other !== path && other.startsWith(path + '/')) ||
			folders?.includes(path)
		)
			throw Error('파일과 폴더의 경로가 겹쳐요.');
	let presentation: CodeProject['presentation'];
	if (value.presentation !== undefined) {
		if (
			!value.presentation ||
			typeof value.presentation !== 'object' ||
			Array.isArray(value.presentation)
		)
			throw Error('화면 배치 설정을 확인해주세요.');
		if (
			Object.keys(value.presentation).some(
				(key) => !['layout', 'chatDock', 'chatRatio', 'chatStyle'].includes(key)
			)
		)
			throw Error('지원하지 않는 화면 배치 설정이에요.');
		const ui = parseGameUI({
			version: 1,
			entry: 'main.tsx',
			modules: { 'main.tsx': { language: 'tsx', source: '' } },
			...value.presentation
		});
		presentation = {
			...(ui.layout ? { layout: ui.layout } : {}),
			...(ui.chatDock ? { chatDock: ui.chatDock } : {}),
			...(ui.chatRatio !== undefined ? { chatRatio: ui.chatRatio } : {}),
			...(ui.chatStyle ? { chatStyle: ui.chatStyle } : {})
		};
	}
	return {
		version: 1,
		entry: value.entry,
		files,
		...(folders ? { folders } : {}),
		...(presentation ? { presentation } : {})
	};
}

/** Existing applied content becomes a source project without executing it. */
export function createCodeProject(game: Pick<Game, 'scripts' | 'ui' | 'code'>): CodeProject {
	if (game.code) return parseCodeProject(game.code);
	const files: CodeProject['files'] = {};
	const exports: string[] = [];
	const registrations: string[] = [];
	const scripts = Object.entries(game.scripts)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([, script]) => script);
	for (const [index, script] of scripts.entries()) {
		const typed = ['typescript', 'ts'].includes(script.language);
		const path = `logic/part-${index + 1}.${typed ? 'ts' : 'js'}`;
		files[path] = {
			language: typed ? 'typescript' : 'javascript',
			source: `export default function register() {\n${script.source}\n}\n`
		};
		registrations.push(`import register${index} from './${path}';`);
	}
	if (registrations.length) {
		files['logic.ts'] = {
			language: 'typescript',
			source:
				registrations.join('\n') +
				'\n\nexport default function register() {\n' +
				registrations.map((_, i) => `  register${i}();`).join('\n') +
				'\n}\n'
		};
		exports.push("export { default as logic } from './logic';");
	}
	let presentation: CodeProject['presentation'];
	if (game.ui) {
		const pathFor = (id: string, language: string) =>
			'ui/' +
			id +
			(/\.(js|ts|jsx|tsx)$/.test(id)
				? ''
				: '.' + ({ javascript: 'js', typescript: 'ts' }[language] ?? language));
		for (const [id, file] of Object.entries(game.ui.modules))
			files[pathFor(id, file.language)] = structuredClone(file);
		exports.push(
			`export { default as ui } from './${pathFor(game.ui.entry, game.ui.modules[game.ui.entry].language)}';`
		);
		const { layout, chatDock, chatRatio, chatStyle } = game.ui;
		presentation = {
			...(layout ? { layout } : {}),
			...(chatDock ? { chatDock } : {}),
			...(chatRatio !== undefined ? { chatRatio } : {}),
			...(chatStyle ? { chatStyle } : {})
		};
	}
	files['main.ts'] = {
		language: 'typescript',
		source: (exports.join('\n') || 'export {};') + '\n'
	};
	return parseCodeProject({
		version: 1,
		entry: 'main.ts',
		files,
		...(presentation ? { presentation } : {})
	});
}

/** Resolve the single authoring entry into two isolated runtime graphs. Never evaluate source here. */
export async function compileCodeProject(
	input: CodeProject
): Promise<Pick<Game, 'scripts' | 'ui'>> {
	const project = parseCodeProject(input);
	const { default: compiler } = await import('typescript');
	function error(message: string, file: string, node?: ts.Node): never {
		const location = node?.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
		throw new CodeProjectError(
			message,
			file,
			(location?.line ?? 0) + 1,
			(location?.character ?? 0) + 1
		);
	}
	function resolve(from: string, specifier: string, node?: ts.Node): string {
		if (!specifier.startsWith('.'))
			return error('프로젝트에 포함된 상대 경로만 불러올 수 있어요.', from, node);
		const parts = from.split('/').slice(0, -1);
		for (const part of specifier.split('/')) {
			if (part === '.' || !part) continue;
			if (part === '..') {
				if (!parts.length) error('프로젝트 밖의 파일은 불러올 수 없어요.', from, node);
				parts.pop();
			} else parts.push(part);
		}
		const path = parts.join('/');
		const found = [
			path,
			...['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'].map(
				(ext) => path + ext
			)
		].find((id) => Object.hasOwn(project.files, id));
		return found ?? error(`파일을 찾을 수 없어요: ${specifier}`, from, node);
	}
	function sourceFile(path: string) {
		const file = project.files[path];
		const tree = compiler.createSourceFile(
			path,
			file.source,
			compiler.ScriptTarget.ES2022,
			true,
			file.language === 'tsx'
				? compiler.ScriptKind.TSX
				: file.language === 'jsx'
					? compiler.ScriptKind.JSX
					: file.language === 'javascript'
						? compiler.ScriptKind.JS
						: compiler.ScriptKind.TS
		);
		const diagnostics = compiler.transpileModule(file.source, {
			fileName: path,
			reportDiagnostics: true,
			compilerOptions: {
				target: compiler.ScriptTarget.ES2022,
				module: compiler.ModuleKind.CommonJS,
				jsx: compiler.JsxEmit.React
			}
		}).diagnostics;
		const failure = diagnostics?.find(
			(item) => item.category === compiler.DiagnosticCategory.Error
		);
		if (failure) {
			const p = tree.getLineAndCharacterOfPosition(failure.start ?? 0);
			throw new CodeProjectError(
				compiler.flattenDiagnosticMessageText(failure.messageText, '\n'),
				path,
				p.line + 1,
				p.character + 1
			);
		}
		return tree;
	}
	const targets: Partial<Record<'logic' | 'ui', string>> = {};
	const main = sourceFile(project.entry);
	for (const statement of main.statements) {
		if (compiler.isEmptyStatement(statement)) continue;
		if (
			!compiler.isExportDeclaration(statement) ||
			statement.isTypeOnly ||
			!statement.exportClause ||
			!compiler.isNamedExports(statement.exportClause)
		)
			error('진입 파일에서는 logic과 ui를 이름으로 다시 내보내세요.', project.entry, statement);
		if (!statement.exportClause.elements.length && !statement.moduleSpecifier) continue;
		if (!statement.moduleSpecifier || !compiler.isStringLiteral(statement.moduleSpecifier))
			error('진입 파일의 내보내기 경로를 확인해주세요.', project.entry, statement);
		for (const entry of statement.exportClause.elements) {
			const name = entry.name.text;
			if (
				!['logic', 'ui'].includes(name) ||
				entry.propertyName?.text !== 'default' ||
				targets[name as 'logic' | 'ui']
			)
				error('logic과 ui는 각각 한 번, 모듈의 default로 연결해야 해요.', project.entry, entry);
			targets[name as 'logic' | 'ui'] = resolve(
				project.entry,
				statement.moduleSpecifier.text,
				statement
			);
		}
	}
	function graph(entry: string, target: 'logic' | 'ui') {
		const modules: CodeProject['files'] = {};
		const dependencies: Record<string, Record<string, string>> = {};
		function collect(path: string) {
			if (Object.hasOwn(modules, path)) return;
			if (path === project.entry) error('진입 파일을 실행 모듈에서 가져올 수 없어요.', path);
			const file = project.files[path];
			if (target === 'logic' && ['jsx', 'tsx'].includes(file.language))
				error('로직에서는 JSX 화면 모듈을 실행할 수 없어요.', path);
			modules[path] = file;
			dependencies[path] = {};
			const tree = sourceFile(path);
			function visit(node: ts.Node) {
				if (
					(compiler.isImportDeclaration(node) || compiler.isExportDeclaration(node)) &&
					node.moduleSpecifier
				) {
					if (
						(compiler.isImportDeclaration(node) && node.importClause?.isTypeOnly) ||
						(compiler.isExportDeclaration(node) && node.isTypeOnly)
					)
						return;
					if (!compiler.isStringLiteral(node.moduleSpecifier))
						error('정적인 모듈 경로가 필요해요.', path, node);
					const specifier = node.moduleSpecifier.text;
					if (target === 'ui' && ['preact', 'preact/hooks', '@helia/ui'].includes(specifier))
						dependencies[path][specifier] = specifier;
					else {
						const id = resolve(path, specifier, node);
						dependencies[path][specifier] = id;
						collect(id);
					}
				}
				if (
					compiler.isMetaProperty(node) ||
					compiler.isImportEqualsDeclaration(node) ||
					(compiler.isCallExpression(node) &&
						(node.expression.kind === compiler.SyntaxKind.ImportKeyword ||
							(compiler.isIdentifier(node.expression) && node.expression.text === 'require')))
				)
					error('동적 모듈 로딩은 지원하지 않아요.', path, node);
				if (
					compiler.isAwaitExpression(node) ||
					(compiler.isForOfStatement(node) && node.awaitModifier)
				) {
					let parent = node.parent;
					while (parent && !compiler.isFunctionLike(parent)) parent = parent.parent;
					if (!parent) error('모듈 최상위의 await는 지원하지 않아요.', path, node);
				}
				compiler.forEachChild(node, visit);
			}
			visit(tree);
		}
		collect(entry);
		return { modules, dependencies };
	}
	const scripts: Game['scripts'] = {};
	if (targets.logic) {
		const { modules, dependencies } = graph(targets.logic, 'logic');
		const factories = Object.entries(modules)
			.map(
				([path, file]) =>
					`${JSON.stringify(path)}:function(module,exports,require){\n${compiler.transpileModule(file.source, { fileName: path, compilerOptions: { target: compiler.ScriptTarget.ES2022, module: compiler.ModuleKind.CommonJS, esModuleInterop: true } }).outputText}\n}`
			)
			.join(',');
		scripts['project'] = {
			language: 'javascript',
			source: `(function(factories,deps,entry){const cache=Object.create(null);function load(id){if(Object.hasOwn(cache,id))return cache[id].exports;const module={exports:{}};cache[id]=module;factories[id](module,module.exports,function(name){const target=deps[id][name];if(!target)throw Error('Unknown module');return load(target);});return module.exports;}const register=load(entry).default;if(typeof register!=='function')throw Error('Logic default must be a function');const result=register();if(result&&typeof result.then==='function')throw Error('Logic registration must be synchronous');})({${factories}},${JSON.stringify(dependencies)},${JSON.stringify(targets.logic)});`
		};
		if (new TextEncoder().encode(scripts.project.source).length > 512 * 1024)
			error('컴파일된 로직이 실행 한도 512 KiB를 넘었어요.', targets.logic);
	}
	let ui: GameUI | undefined;
	if (targets.ui) {
		const { modules } = graph(targets.ui, 'ui');
		ui = parseGameUI({ version: 1, entry: targets.ui, modules, ...project.presentation });
	}
	return { scripts, ui };
}
export async function compileAuthoringGame(game: Game): Promise<Game> {
	if (!game.code) return game;
	const compiled = await compileCodeProject(game.code);
	return { ...game, scripts: compiled.scripts, ui: compiled.ui };
}
