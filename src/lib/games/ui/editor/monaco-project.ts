import type { editor, IDisposable, IPosition, IRange } from 'monaco-editor/editor/editor.api.js';

import type { CodeDiagnostic, SourceModule } from '../../code-authoring.js';

import {
	HELIA_AUTHORING_DECLARATIONS,
	HELIA_AUTHORING_LIBRARIES
} from '../../authoring/runtime.js';

type Runtime = typeof import('./monaco-runtime.js');
type Position = { lineNumber: number; column: number };
let runtime: Promise<Runtime> | undefined;
export function loadMonaco() {
	return (runtime ??= import('./monaco-runtime.js'));
}
let sequence = 0;
export interface MonacoDocument {
	source: string;
	language: string;
}
export class MonacoProject {
	readonly root = 'file:///helia-authoring/project-' + ++sequence + '/';
	private models = new Map<string, editor.ITextModel>();
	private views = new Map<string, editor.ICodeEditorViewState>();
	private pending: Record<string, MonacoDocument> = {};
	private runtime: Runtime | undefined;
	private markerListener: IDisposable | undefined;
	private opener: IDisposable | undefined;
	private disposed = false;
	private diagnostics: ((items: CodeDiagnostic[]) => void) | undefined;
	private codePaths = new Set<string>();
	private preparation: Promise<void> = Promise.resolve();
	private syncGeneration = 0;
	/** Resolves a project-relative model path to an editor tab. Ctrl+click and Go to Definition use it. */
	openSource: ((path: string, position?: Position) => boolean) | undefined;
	update(
		files: Record<string, SourceModule>,
		stateTypes: string,
		documents: Record<string, string> = {},
		ondiagnostics?: (items: CodeDiagnostic[]) => void
	) {
		this.diagnostics = ondiagnostics;
		this.codePaths = new Set(Object.keys(files));
		// The generated state module also activates the language service before source models.
		this.pending = {
			'.helia/GameState.d.ts': {
				source: stateTypes || 'export type GameState = Record<string, unknown>;',
				language: 'typescript'
			},
			'.helia/runtime.d.ts': { source: HELIA_AUTHORING_DECLARATIONS, language: 'typescript' },
			...Object.fromEntries(
				Object.entries(HELIA_AUTHORING_LIBRARIES).map(([path, source]) => [
					path,
					{ source, language: 'typescript' }
				])
			),
			...files,
			...Object.fromEntries(
				Object.entries(documents).map(([path, source]) => [path, { source, language: 'json' }])
			)
		};
		this.sync();
	}
	async ready() {
		const runtime = await loadMonaco();
		if (this.disposed) {
			throw new Error('Editor project was closed.');
		}
		if (!this.runtime) {
			this.runtime = runtime;
			this.markerListener = runtime.monaco.editor.onDidChangeMarkers((uris) => {
				if (uris.some((uri) => uri.toString().startsWith(this.root))) {
					this.publishDiagnostics();
				}
			});
			this.opener = runtime.monaco.editor.registerEditorOpener({
				openCodeEditor: (_source, resource, selection) => {
					const target = projectOpenTarget(this.root, resource.toString(), selection);
					return target ? (this.openSource?.(target.path, target.position) ?? false) : false;
				}
			});
			this.sync();
		}
		let preparation: Promise<void>;
		do {
			preparation = this.preparation;
			await preparation;
		} while (preparation !== this.preparation);
		return runtime;
	}
	private sync() {
		if (!this.runtime || this.disposed) {
			return;
		}
		for (const [path, file] of Object.entries(this.pending)) {
			const language = modelLanguage(file.language);
			this.syncModel(path, file, language);
			// A file with its own model needs no extra library: the worker reads the model first.
			// Registering both made every keystroke look like an extra-library change, which
			// re-validates all models and repaints diagnostics such as unused-code fading.
		}
		this.removeDeletedModels();
		const generation = ++this.syncGeneration;
		if ([...this.models.values()].some((model) => model.getLanguageId() === 'plaintext')) {
			this.preparation = this.prepareTypes(generation);
			// ready() reports startup failures; background updates can retry on the next sync.
			void this.preparation.catch(() => {});
		}
		this.publishDiagnostics();
	}
	private async prepareTypes(generation: number) {
		const worker = await this.runtime!.readyTypeScriptWorker();
		if (this.disposed || generation !== this.syncGeneration) {
			return;
		}
		const resources = [...this.models.entries()]
			.filter(([path]) => modelLanguage(this.pending[path].language) === 'typescript')
			.map(([, model]) => model.uri);
		// Sync the entire graph before enabling native diagnostics on the new source models.
		await worker(...resources);
		if (this.disposed || generation !== this.syncGeneration) {
			return;
		}
		for (const [path, model] of this.models) {
			const language = modelLanguage(this.pending[path].language);
			if (model.getLanguageId() !== language) {
				this.runtime!.monaco.editor.setModelLanguage(model, language);
			}
		}
	}
	private syncModel(path: string, file: MonacoDocument, language: string) {
		const { monaco } = this.runtime!;
		const model = this.models.get(path);
		if (!model) {
			this.models.set(
				path,
				monaco.editor.createModel(
					file.source,
					language === 'typescript' && path !== '.helia/GameState.d.ts' ? 'plaintext' : language,
					monaco.Uri.parse(this.root + path)
				)
			);
			return;
		}
		if (model.getLanguageId() !== language && language !== 'typescript') {
			monaco.editor.setModelLanguage(model, language);
		}
		if (model.getValue() !== file.source) {
			model.setValue(file.source);
		}
	}
	private removeDeletedModels() {
		for (const [path, model] of this.models) {
			if (Object.hasOwn(this.pending, path)) {
				continue;
			}
			model.dispose();
			this.models.delete(path);
			this.views.delete(path);
		}
	}
	private publishDiagnostics() {
		if (!this.runtime) {
			return;
		}
		const { monaco } = this.runtime;
		const result: CodeDiagnostic[] = [];
		for (const path of this.codePaths) {
			const model = this.models.get(path);
			if (!model) {
				continue;
			}
			for (const marker of monaco.editor.getModelMarkers({ resource: model.uri })) {
				if (marker.severity < monaco.MarkerSeverity.Warning) {
					continue;
				}
				result.push({
					module: path,
					line: marker.startLineNumber,
					column: marker.startColumn,
					message: marker.message
				});
			}
		}
		this.diagnostics?.(result.slice(0, 100));
	}
	model(path: string, source: string, language: string) {
		if (!Object.hasOwn(this.pending, path)) {
			this.pending = { ...this.pending, [path]: { source, language } };
			this.sync();
		}
		return this.models.get(path)!;
	}
	saveView(key: string, view: editor.ICodeEditorViewState | null) {
		if (view) {
			this.views.set(key, view);
		}
	}
	view(key: string) {
		return this.views.get(key);
	}
	dispose() {
		this.disposed = true;
		this.markerListener?.dispose();
		this.opener?.dispose();
		this.openSource = undefined;
		for (const model of this.models.values()) {
			model.dispose();
		}
		this.models.clear();
		this.views.clear();
	}
}

/** Resolves an authoring model URI to the tab path and caret the opener should use. */
export function projectOpenTarget(
	root: string,
	uri: string,
	selection?: IRange | IPosition
): { path: string; position?: Position } | undefined {
	if (!uri.startsWith(root)) {
		return undefined;
	}
	return { path: uri.slice(root.length), position: caretOf(selection) };
}

function caretOf(selection?: IRange | IPosition): Position | undefined {
	if (!selection) {
		return undefined;
	}
	if ('startLineNumber' in selection) {
		return { lineNumber: selection.startLineNumber, column: selection.startColumn };
	}
	return { lineNumber: selection.lineNumber, column: selection.column };
}

function modelLanguage(language: string) {
	const normalized = language.toLowerCase();
	if (['ts', 'typescript', 'tsx'].includes(normalized)) {
		return 'typescript';
	}
	if (normalized === 'css') {
		return 'css';
	}
	return 'json';
}
