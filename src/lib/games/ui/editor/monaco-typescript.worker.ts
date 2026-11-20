import {
	TypeScriptWorker,
	initialize,
	ts as services
} from 'monaco-editor/languages/features/typescript/ts.worker.js';

import { authoringBindings } from '../../authoring/environment.js';

const ts = services.typescript;

/** Monaco shares a language worker; keep ambient declarations scoped to the requesting project. */
class ProjectWorker extends TypeScriptWorker {
	private root = '';
	private signature = '';
	private bindings = new Map<string, string>();
	select(file: string) {
		this.root = /^file:\/\/\/helia-authoring\/[^/]+\//.exec(file)?.[0] ?? '';
		this.updateBindings();
	}
	private updateBindings() {
		const files = this.getScriptFileNames().filter(
			(file) => file.startsWith(this.root) && !file.endsWith('.d.ts') && /\.(?:ts|tsx)$/.test(file)
		);
		const signature = files.map((file) => file + ':' + super.getScriptVersion(file)).join('|');
		if (signature === this.signature) {
			return;
		}
		this.signature = signature;
		const sources = new Map(
			files.map((file) => {
				const snapshot = super.getScriptSnapshot(file)!;
				return [file, snapshot.getText(0, snapshot.getLength())] as const;
			})
		);
		this.bindings = authoringBindings(ts, sources);
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
		if (!this.allowed(file)) {
			return undefined;
		}
		const snapshot = super.getScriptSnapshot(file);
		const binding = this.bindings.get(file);
		return snapshot && binding
			? ts.ScriptSnapshot.fromString(snapshot.getText(0, snapshot.getLength()) + binding)
			: snapshot;
	}
	override getScriptVersion(file: string) {
		return super.getScriptVersion(file) + (this.bindings.get(file) ?? '');
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
							if (typeof args[0] === 'string' && args[0].startsWith('file:///helia-authoring/')) {
								target.select(args[0]);
							}
							return Reflect.apply(value, target, args);
						}
					: value;
			}
		});
	});
