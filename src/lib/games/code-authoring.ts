import type ts from 'typescript';
import { parseScripts } from './model.js';
import { parseGameUI } from './ui/runtime/model.js';

export interface SourceModule {
	language: string;
	source: string;
}
export interface AuthoringBundle {
	modules: Record<string, SourceModule>;
	/** The original object is retained so source editing never erases layout or presentation. */
	value: Record<string, unknown>;
}
export interface CodeDiagnostic {
	module: string;
	line: number;
	column: number;
	message: string;
}

export function readAuthoringBundle(
	source: string,
	kind: 'scripts' | 'ui'
): AuthoringBundle | null {
	const value: unknown = JSON.parse(source);
	if (kind === 'scripts') {
		const modules = parseScripts(value);
		return { modules, value: modules };
	}
	if (value === null) return null;
	const ui = parseGameUI(value);
	return { modules: ui.modules, value: value as Record<string, unknown> };
}

export function writeAuthoringBundle(
	bundle: AuthoringBundle,
	kind: 'scripts' | 'ui',
	modules: Record<string, SourceModule>,
	entry?: string
): string {
	return JSON.stringify(
		kind === 'scripts'
			? modules
			: { ...bundle.value, modules, ...(entry === undefined ? {} : { entry }) },
		null,
		2
	);
}

const declarations = `
type GameState = import('./GameState').GameState;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type ReadonlyState<T> = { readonly [K in keyof T]: T[K] extends object ? ReadonlyState<T[K]> : T[K] };
interface ActionContext { state: GameState; args: Record<string, JsonValue>; }
interface ReadContext { state: ReadonlyState<GameState>; args: Record<string, JsonValue>; }
interface ActionDefinition { name: string; arguments: object; description?: string; ai?: boolean; run(context: ActionContext): GameState; }
interface QueryDefinition { name: string; arguments: object; description?: string; ai?: boolean; run(context: ReadContext): JsonValue; }
interface RuleDefinition { name: string; priority?: number; actions?: string[]; mode?: 'included' | 'independent'; run(context: ReadContext): unknown; }
declare const helia: {
 defineAction(definition: ActionDefinition): void;
 defineQuery(definition: QueryDefinition): void;
 defineFilter(definition: RuleDefinition): void;
 defineHook(definition: RuleDefinition): void;
 emit(name: string, payload?: JsonValue): void;
 requestAI(text: string, options?: { visible?: boolean }): void;
 asset(id: string): string;
 getState(): ReadonlyState<GameState>;
 action(name: string, args?: JsonValue): Promise<unknown>;
 transaction(action: string, state: GameState): Promise<unknown>;
 ai(text: string, options?: { visible?: boolean }): Promise<unknown>;
 registerPanel(panel: { id: string; title: string; component: () => unknown }): () => void;
};
declare namespace JSX { interface Element {} interface IntrinsicElements { [name: string]: Record<string, unknown> } }
declare module '@helia/ui' {
 export const helia: typeof globalThis.helia;
 export function useGameState(): ReadonlyState<GameState>;
 export function getState(): ReadonlyState<GameState>;
 export function useUIState<T>(key: string, initial: T): [T, (next: T | ((previous: T) => T)) => void];
 export function useUIEvent(event: string, listener: (payload: JsonValue) => void): void;
 export function onEvent(event: string, listener: (payload: JsonValue) => void): () => void;
 export function onDispose(dispose: () => void): () => void;
 export const registerPanel: typeof helia.registerPanel;
 export const action: typeof helia.action;
 export const transaction: typeof helia.transaction;
 export const ai: typeof helia.ai;
 export const asset: typeof helia.asset;
 export function Button(props: Record<string, unknown>): JSX.Element;
 export function Text(props: Record<string, unknown>): JSX.Element;
 export function Progress(props: Record<string, unknown>): JSX.Element;
 export function Inventory(props: Record<string, unknown>): JSX.Element;
 export function Stats(props: Record<string, unknown>): JSX.Element;
 export function QuestList(props: Record<string, unknown>): JSX.Element;
}
declare module 'preact' { export function h(type: unknown, props: unknown, ...children: unknown[]): JSX.Element; export const Fragment: unknown; }
declare module 'preact/hooks' {
 export function useState<T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void];
 export function useEffect(effect: () => void | (() => void), dependencies?: readonly unknown[]): void;
 export function useMemo<T>(factory: () => T, dependencies: readonly unknown[]): T;
 export function useRef<T>(value: T): { current: T };
}
`;

/** A browser-only virtual program. No authored code is executed and no files are read from disk. */
export async function diagnoseCode(
	modules: Record<string, SourceModule>,
	stateTypes: string
): Promise<CodeDiagnostic[]> {
	const [{ default: compiler }, standardLibraries] = await Promise.all([
		import('typescript'),
		Promise.all([
			import('typescript/lib/lib.es5.d.ts?raw'),
			import('typescript/lib/lib.es2015.core.d.ts?raw'),
			import('typescript/lib/lib.es2015.collection.d.ts?raw'),
			import('typescript/lib/lib.es2015.symbol.d.ts?raw'),
			import('typescript/lib/lib.es2015.iterable.d.ts?raw'),
			import('typescript/lib/lib.es2015.promise.d.ts?raw'),
			import('typescript/lib/lib.es2016.array.include.d.ts?raw'),
			import('typescript/lib/lib.es2017.object.d.ts?raw'),
			import('typescript/lib/lib.es2017.string.d.ts?raw'),
			import('typescript/lib/lib.es2019.array.d.ts?raw'),
			import('typescript/lib/lib.es2019.object.d.ts?raw'),
			import('typescript/lib/lib.es2020.promise.d.ts?raw'),
			import('typescript/lib/lib.es2021.string.d.ts?raw'),
			import('typescript/lib/lib.es2022.array.d.ts?raw'),
			import('typescript/lib/lib.es2022.object.d.ts?raw')
		])
	]);
	const files = new Map<string, string>([
		['/GameState.d.ts', stateTypes],
		['/runtime.d.ts', declarations],
		['/lib.d.ts', standardLibraries.map((item) => item.default).join('\n')]
	]);
	const moduleNames = new Map<string, string>();
	const modulePaths = new Map<string, string>();
	for (const [id, module] of Object.entries(modules)) {
		const extension =
			({ jsx: '.jsx', tsx: '.tsx', javascript: '.js', js: '.js' } as Record<string, string>)[
				module.language
			] ?? '.ts';
		// The language is explicit; two different IDs must not collide after extension replacement.
		const path = '/modules/' + id + extension;
		files.set(path, module.source);
		moduleNames.set(path, id);
		modulePaths.set(id, path);
	}
	const options: ts.CompilerOptions = {
		target: compiler.ScriptTarget.ES2022,
		module: compiler.ModuleKind.ESNext,
		// Runtime wraps every script in its own function; local declarations must not collide.
		moduleDetection: compiler.ModuleDetectionKind.Force,
		jsx: compiler.JsxEmit.Preserve,
		strict: true,
		allowJs: true,
		checkJs: true,
		noLib: true,
		skipLibCheck: true,
		noEmit: true
	};
	const host: ts.CompilerHost = {
		getSourceFile: (path, version) =>
			files.has(path)
				? compiler.createSourceFile(path, files.get(path)!, version, true)
				: undefined,
		getDefaultLibFileName: () => '/lib.d.ts',
		writeFile: () => {},
		getCurrentDirectory: () => '/',
		getDirectories: () => [],
		getCanonicalFileName: (path) => path,
		useCaseSensitiveFileNames: () => true,
		getNewLine: () => '\n',
		fileExists: (path) => files.has(path),
		readFile: (path) => files.get(path),
		resolveModuleNames: (names, from) =>
			names.map((name) => {
				if (['@helia/state', 'GameState'].includes(name))
					return { resolvedFileName: '/GameState.d.ts' };
				if (!name.startsWith('.')) return undefined;
				if (from === '/runtime.d.ts' && name === './GameState')
					return { resolvedFileName: '/GameState.d.ts' };
				const parts = (moduleNames.get(from) ?? '').split('/').slice(0, -1);
				for (const part of name.split('/')) {
					if (part === '..') parts.pop();
					else if (part !== '.') parts.push(part);
				}
				const path = parts.join('/');
				const found = [
					path,
					...['.ts', '.tsx', '.js', '.jsx', '.d.ts', '/index.ts', '/index.tsx'].map(
						(ext) => path + ext
					)
				].find((candidate) => modulePaths.has(candidate));
				return found ? { resolvedFileName: modulePaths.get(found)! } : undefined;
			})
	};
	const program = compiler.createProgram([...files.keys()], options, host);
	return [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()]
		.flatMap((item) => {
			if (!item.file || item.start === undefined || !moduleNames.has(item.file.fileName)) return [];
			const location = item.file.getLineAndCharacterOfPosition(item.start);
			return [
				{
					module: moduleNames.get(item.file.fileName)!,
					line: location.line + 1,
					column: location.character + 1,
					message: compiler.flattenDiagnosticMessageText(item.messageText, '\n')
				}
			];
		})
		.slice(0, 100);
}
