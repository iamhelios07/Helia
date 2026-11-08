declare module 'monaco-editor/languages/features/typescript/ts.worker.js' {
	export class TypeScriptWorker {
		constructor(context: unknown, data: unknown);
		getScriptFileNames(): string[];
		readFile(path: string): string | undefined;
		fileExists(path: string): boolean;
		getScriptSnapshot(path: string): unknown;
	}
	export function initialize(factory: (context: unknown, data: unknown) => object): void;
}
