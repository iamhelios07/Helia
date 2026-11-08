import {
	TypeScriptWorker,
	initialize
} from 'monaco-editor/languages/features/typescript/ts.worker.js';

/** Monaco shares a language worker; keep ambient declarations scoped to the requesting project. */
class ProjectWorker extends TypeScriptWorker {
	private root = '';
	select(file: string) {
		this.root = /^file:\/\/\/helia-authoring\/[^/]+\//.exec(file)?.[0] ?? '';
	}
	private allowed(file: string) {
		return !file.startsWith('file:///helia-authoring/') || file.startsWith(this.root);
	}
	override readFile(file: string) {
		return this.allowed(file) ? super.readFile(file) : undefined;
	}
	override fileExists(file: string) {
		return this.allowed(file) && super.fileExists(file);
	}
	override getScriptSnapshot(file: string) {
		return this.allowed(file) ? super.getScriptSnapshot(file) : undefined;
	}
	override getScriptFileNames() {
		return [...new Set(super.getScriptFileNames().filter((file) => this.allowed(file)))];
	}
}
self.onmessage = () =>
	initialize((context, data) => {
		const worker = new ProjectWorker(context, data);
		return new Proxy(worker, {
			get(target, property) {
				const value: unknown = Reflect.get(target, property);
				return typeof value === 'function'
					? (...args: unknown[]) => {
							if (typeof args[0] === 'string' && args[0].startsWith('file:///helia-authoring/'))
								target.select(args[0]);
							return Reflect.apply(value, target, args);
						}
					: value;
			}
		});
	});
