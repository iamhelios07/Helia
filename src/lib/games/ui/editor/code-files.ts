import { validCodePath, type CodeProject } from '../../code-project.js';

export function codeLanguage(path: string): 'javascript' | 'typescript' | 'jsx' | 'tsx' {
	const extension = path.split('.').at(-1);
	if (extension === 'js') return 'javascript';
	if (extension === 'ts') return 'typescript';
	if (extension === 'jsx' || extension === 'tsx') return extension;
	throw new Error('파일 확장자는 .js, .ts, .jsx, .tsx를 사용해주세요.');
}

export function cleanProjectPath(value: string): string {
	const path = value.trim().replaceAll('\\', '/');
	if (!validCodePath(path, true))
		throw new Error('경로에는 영문, 숫자, 밑줄, 마침표, 하이픈과 /를 사용해주세요.');
	if (path === 'GameState.d.ts') throw new Error('GameState.d.ts는 자동 생성되는 파일이에요.');
	return path;
}

function resolved(from: string, request: string, paths: string[]): string | undefined {
	if (!request.startsWith('.')) return;
	const parts = from.split('/').slice(0, -1);
	for (const part of request.split('/')) {
		if (part === '..') parts.pop();
		else if (part !== '.') parts.push(part);
	}
	const path = parts.join('/');
	return (
		paths.find((candidate) => candidate === path) ??
		paths.find((candidate) =>
			['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'].some(
				(suffix) => candidate === path + suffix
			)
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

/** Keep relative imports attached to their targets when a file or directory moves. */
export async function renameCodePath(
	project: CodeProject,
	before: string,
	after: string
): Promise<CodeProject> {
	const { default: ts } = await import('typescript');
	const moved = (path: string) =>
		path === before
			? after
			: path.startsWith(before + '/')
				? after + path.slice(before.length)
				: path;
	const originalPaths = Object.keys(project.files);
	const paths = originalPaths.map(moved);
	if (new Set(paths).size !== paths.length) throw new Error('같은 경로의 파일이 이미 있어요.');
	const files: CodeProject['files'] = {};
	for (const [path, file] of Object.entries(project.files)) {
		const nextPath = moved(path);
		const parsed = ts.createSourceFile(path, file.source, ts.ScriptTarget.Latest, true);
		const edits: { start: number; end: number; text: string }[] = [];
		const visit = (node: import('typescript').Node) => {
			if (
				(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
				node.moduleSpecifier &&
				ts.isStringLiteral(node.moduleSpecifier)
			) {
				const request = node.moduleSpecifier;
				const target = resolved(path, request.text, originalPaths);
				if (target && (moved(target) !== target || nextPath !== path))
					edits.push({
						start: request.getStart(parsed) + 1,
						end: request.getEnd() - 1,
						text: relative(nextPath, moved(target))
					});
			}
			ts.forEachChild(node, visit);
		};
		visit(parsed);
		let source = file.source;
		for (const edit of edits.sort((a, b) => b.start - a.start))
			source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
		files[nextPath] = { source, language: codeLanguage(nextPath) };
	}
	return {
		...project,
		entry: moved(project.entry),
		files,
		...(project.folders ? { folders: project.folders.map(moved) } : {})
	};
}
