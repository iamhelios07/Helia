import {
	GAME_STYLESHEET,
	parseCodeProject,
	validCodePath,
	type CodeProject
} from '../../code-project.js';

/** Includes implicit ancestors and declared empty folders, so both remain reachable in the tree. */
export function codeFolders(project: CodeProject): string[] {
	const folders = new Set<string>();
	for (const path of [...(project.folders ?? []), ...Object.keys(project.files)]) {
		const parts = path.split('/');
		if (!project.folders?.includes(path)) {
			parts.pop();
		}
		while (parts.length) {
			folders.add(parts.join('/'));
			parts.pop();
		}
	}
	return [...folders].sort();
}

function validateMove(project: CodeProject, before: string, after: string) {
	cleanProjectPath(before);
	cleanProjectPath(after);
	const folders = codeFolders(project);
	if (!Object.hasOwn(project.files, before) && !folders.includes(before)) {
		throw new Error('이동할 코드 경로가 없어요.');
	}
	if (before === after) {
		return;
	}
	if (before === GAME_STYLESHEET) {
		throw new Error('style.css는 이름을 바꾸거나 이동할 수 없어요.');
	}
	if (after.startsWith(before + '/')) {
		throw new Error('폴더를 자기 자신이나 하위 폴더로 이동할 수 없어요.');
	}
	if (Object.hasOwn(project.files, after) || folders.includes(after)) {
		throw new Error('같은 경로가 이미 있어요.');
	}
}

/** A file-row drop adopts that row's parent; folder-row drops go inside the folder. */
export function codeDropPath(project: CodeProject, before: string, folder: string): string | null {
	if (folder && !codeFolders(project).includes(folder)) {
		throw new Error('대상 코드 폴더가 없어요.');
	}
	if (folder === before || folder.startsWith(before + '/')) {
		throw new Error('폴더를 자기 자신이나 하위 폴더로 이동할 수 없어요.');
	}
	const after = [folder, before.split('/').at(-1)].filter(Boolean).join('/');
	validateMove(project, before, after);
	return before === after ? null : after;
}

export function codeLanguage(path: string): 'typescript' | 'tsx' | 'css' {
	const extension = path.split('.').at(-1);
	if (extension === 'ts') {
		return 'typescript';
	}
	if (extension === 'tsx') {
		return 'tsx';
	}
	if (path === GAME_STYLESHEET) {
		return 'css';
	}
	throw new Error('파일 확장자는 .ts, .tsx를 사용해주세요.');
}

export function cleanProjectPath(value: string): string {
	const path = value.trim().replaceAll('\\', '/');
	if (!validCodePath(path, true)) {
		throw new Error('경로에는 영문, 숫자, 밑줄, 마침표, 하이픈과 /를 사용해주세요.');
	}
	if (path === '.helia' || path.startsWith('.helia/')) {
		throw new Error('.helia는 자동 생성 파일 전용 폴더예요.');
	}
	return path;
}

function resolved(from: string, request: string, paths: string[]): string | undefined {
	if (!request.startsWith('.')) {
		return;
	}
	const parts = from.split('/').slice(0, -1);
	for (const part of request.split('/')) {
		if (part === '..') {
			parts.pop();
		} else if (part !== '.') {
			parts.push(part);
		}
	}
	const path = parts.join('/');
	return (
		paths.find((candidate) => candidate === path) ??
		paths.find((candidate) =>
			['.ts', '.tsx', '/index.ts', '/index.tsx'].some((suffix) => candidate === path + suffix)
		)
	);
}

function relative(from: string, to: string): string {
	const left = from.split('/').slice(0, -1);
	const right = to.split('/');
	while (left.length && left[0] === right[0]) {
		left.shift();
		right.shift();
	}
	const path = [...left.map(() => '..'), ...right].join('/');
	return path.startsWith('.') ? path : './' + path;
}

function moduleRequest(node: import('typescript').Node, ts: typeof import('typescript')) {
	let request: import('typescript').Node | undefined;
	if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
		request = node.moduleSpecifier;
	} else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
		request = node.arguments[0];
	} else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
		request = node.argument.literal;
	}
	return request && ts.isStringLiteralLike(request) ? request : undefined;
}

/** Persist emptied source folders without duplicating every implicit ancestor in the manifest. */
function retainedFolders(
	project: CodeProject,
	files: CodeProject['files'],
	moved: (path: string) => string
): string[] {
	const declared = new Set((project.folders ?? []).map(moved));
	const occupied = new Set(codeFolders({ ...project, files, folders: [] }));
	const empty = codeFolders(project)
		.map(moved)
		.filter((path) => !occupied.has(path));
	for (const path of empty) {
		if (!empty.some((other) => other.startsWith(path + '/'))) {
			declared.add(path);
		}
	}
	return [...declared];
}

/** Keep relative imports attached to their targets when a file or directory moves. */
export async function renameCodePath(
	project: CodeProject,
	before: string,
	after: string
): Promise<CodeProject> {
	validateMove(project, before, after);
	if (before === after) {
		return project;
	}
	const { default: ts } = await import('typescript');
	const moved = (path: string) => {
		if (path === before) {
			return after;
		}
		return path.startsWith(before + '/') ? after + path.slice(before.length) : path;
	};
	const originalPaths = Object.keys(project.files);
	const paths = originalPaths.map(moved);
	if (new Set(paths).size !== paths.length) {
		throw new Error('같은 경로의 파일이 이미 있어요.');
	}
	const files: CodeProject['files'] = {};
	for (const [path, file] of Object.entries(project.files)) {
		const nextPath = moved(path);
		const parsed = ts.createSourceFile(path, file.source, ts.ScriptTarget.Latest, true);
		const edits: { start: number; end: number; text: string }[] = [];
		const visit = (node: import('typescript').Node) => {
			const request = moduleRequest(node, ts);
			if (request) {
				const target = resolved(path, request.text, originalPaths);
				if (target && (moved(target) !== target || nextPath !== path)) {
					edits.push({
						start: request.getStart(parsed) + 1,
						end: request.getEnd() - 1,
						text: relative(nextPath, moved(target))
					});
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(parsed);
		let source = file.source;
		for (const edit of edits.sort((a, b) => b.start - a.start)) {
			source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
		}
		files[nextPath] = { source, language: codeLanguage(nextPath) };
	}
	return parseCodeProject({
		...project,
		entry: moved(project.entry),
		files,
		folders: retainedFolders(project, files, moved)
	});
}
