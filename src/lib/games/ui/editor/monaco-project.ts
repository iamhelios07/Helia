import type { editor, IDisposable } from 'monaco-editor/editor/editor.api.js';

import type { CodeDiagnostic, SourceModule } from '../../code-authoring.js';

import { HELIA_AUTHORING_DECLARATIONS } from '../../code-authoring.js';
type Runtime = typeof import('./monaco-runtime.js');
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
	private libraries = new Map<string, { source: string; dispose: () => void }>();
	private models = new Map<string, editor.ITextModel>();
	private views = new Map<string, editor.ICodeEditorViewState>();
	private pending: Record<string, MonacoDocument> = {};
	private runtime: Runtime | undefined;
	private markerListener: IDisposable | undefined;
	private disposed = false;
	private diagnostics: ((items: CodeDiagnostic[]) => void) | undefined;
	private codePaths = new Set<string>();
	update(
		files: Record<string, SourceModule>,
		stateTypes: string,
		documents: Record<string, string> = {},
		ondiagnostics?: (items: CodeDiagnostic[]) => void
	) {
		this.diagnostics = ondiagnostics;
		this.codePaths = new Set(Object.keys(files));
		this.pending = {
			...files,
			...Object.fromEntries(
				Object.entries(documents).map(([path, source]) => [path, { source, language: 'json' }])
			),
			'GameState.d.ts': {
				source: stateTypes || 'export type GameState = Record<string, unknown>;',
				language: 'typescript'
			},
			'.helia/runtime.d.ts': {
				source:
					HELIA_AUTHORING_DECLARATIONS.replaceAll("'./GameState'", "'../GameState'") +
					"\ndeclare module '@helia/state' { export type GameState = import('../GameState').GameState; }",
				language: 'typescript'
			}
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
			this.sync();
		}
		return runtime;
	}
	private sync() {
		if (!this.runtime || this.disposed) {
			return;
		}
		for (const [path, file] of Object.entries(this.pending)) {
			const language = modelLanguage(file.language);
			if (language !== 'json') {
				this.syncLibrary(path, file.source);
			}
			this.syncModel(path, file, language);
		}
		this.removeDeletedModels();
		this.publishDiagnostics();
	}
	private syncLibrary(path: string, source: string) {
		const previous = this.libraries.get(path);
		if (previous?.source === source) {
			return;
		}
		previous?.dispose();
		const library = this.runtime!.addProjectLibrary(source, this.root + path);
		this.libraries.set(path, { source, dispose: () => library.dispose() });
	}
	private syncModel(path: string, file: MonacoDocument, language: string) {
		const { monaco } = this.runtime!;
		const model = this.models.get(path);
		if (!model) {
			this.models.set(
				path,
				monaco.editor.createModel(file.source, language, monaco.Uri.parse(this.root + path))
			);
			return;
		}
		if (model.getLanguageId() !== language) {
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
			this.libraries.get(path)?.dispose();
			this.libraries.delete(path);
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
		for (const model of this.models.values()) {
			model.dispose();
		}
		this.models.clear();
		for (const library of this.libraries.values()) {
			library.dispose();
		}
		this.libraries.clear();
		this.views.clear();
	}
}

function modelLanguage(language: string) {
	const normalized = language.toLowerCase();
	if (['js', 'javascript', 'jsx'].includes(normalized)) {
		return 'javascript';
	}
	if (['ts', 'typescript', 'tsx'].includes(normalized)) {
		return 'typescript';
	}
	return 'json';
}
