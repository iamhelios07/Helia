declare module 'monaco-editor/languages/features/typescript/ts.worker.js' {
	export class TypeScriptWorker {
		constructor(context: unknown, data: unknown);
		getScriptFileNames(): string[];
		getScriptVersion(path: string): string;
		readFile(path: string): string | undefined;
		fileExists(path: string): boolean;
		getScriptSnapshot(path: string): import('typescript').IScriptSnapshot | undefined;
	}
	export const ts: { typescript: typeof import('typescript') };
	export function initialize(factory: (context: unknown, data: unknown) => object): void;
}
declare module 'monaco-editor/language/css/monaco.contribution.js';
