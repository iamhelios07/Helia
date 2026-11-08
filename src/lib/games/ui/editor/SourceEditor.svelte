<script lang="ts">
	import { untrack } from 'svelte';
	import type { editor } from 'monaco-editor/editor/editor.api.js';
	import { MonacoProject } from './monaco-project.js';
	let {
		value,
		label,
		language = 'JSON',
		readonly = false,
		disabled = false,
		project,
		path = 'document.json',
		viewId = 'primary',
		location,
		onchange
	}: {
		value: string;
		label: string;
		language?: string;
		readonly?: boolean;
		disabled?: boolean;
		project?: MonacoProject;
		path?: string;
		viewId?: string;
		location?: { line: number; column: number; sequence: number };
		onchange?: (value: string) => void;
	} = $props();
	const localProject = new MonacoProject();
	let instance = $state.raw<editor.IStandaloneCodeEditor>();
	let loadError = $state('');
	let position = $state({ lineNumber: 1, column: 1 });
	let modelUri = $derived((project ?? localProject).root + path);
	let activePath = '';
	function attach(element: HTMLDivElement) {
		let disposed = false;
		const session = untrack(() => project ?? localProject);
		void session
			.ready()
			.then(({ monaco }) => {
				if (disposed) return;
				const codeEditor = monaco.editor.create(element, {
					model: untrack(() => session.model(path, value, language)),
					theme: 'helia',
					automaticLayout: true,
					minimap: { enabled: false },
					fontSize: 12,
					lineHeight: 21,
					tabSize: 2,
					insertSpaces: true,
					fontFamily: "Consolas, 'SFMono-Regular', monospace",
					scrollBeyondLastLine: false,
					padding: { top: 16, bottom: 16 },
					lineNumbersMinChars: 3,
					glyphMargin: false,
					overviewRulerLanes: 0,
					hideCursorInOverviewRuler: true,
					renderLineHighlight: 'line',
					scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6, useShadows: false },
					fixedOverflowWidgets: true,
					accessibilitySupport: 'on',
					editContext: false,
					ariaLabel: untrack(() => label),
					readOnly: untrack(() => readonly || disabled),
					domReadOnly: untrack(() => readonly || disabled),
					wordBasedSuggestions: 'off',
					quickSuggestions: { other: true, comments: false, strings: false }
				});
				const content = codeEditor.onDidChangeModelContent(() => {
					if (readonly || disabled || codeEditor.getModel()?.uri.toString() !== session.root + path)
						return;
					onchange?.(codeEditor.getValue());
				});
				const cursor = codeEditor.onDidChangeCursorPosition((event) => (position = event.position));
				instance = codeEditor;
				cleanup = () => {
					session.saveView(viewId + ':' + activePath, codeEditor.saveViewState());
					content.dispose();
					cursor.dispose();
					codeEditor.dispose();
				};
			})
			.catch(() => {
				if (!disposed) loadError = '코드 편집기를 불러오지 못했어요.';
			});
		let cleanup: (() => void) | undefined;
		return () => {
			disposed = true;
			cleanup?.();
			instance = undefined;
			localProject.dispose();
		};
	}
	$effect(() => {
		const codeEditor = instance;
		const session = project ?? localProject;
		const currentPath = path;
		const source = value;
		const mode = language;
		if (!codeEditor) return;
		if (!project) session.update({ [currentPath]: { source, language: mode } }, '');
		const model = session.model(currentPath, source, mode);
		if (activePath !== currentPath || codeEditor.getModel() !== model) {
			session.saveView(viewId + ':' + activePath, codeEditor.saveViewState());
			activePath = currentPath;
			codeEditor.setModel(model);
			const saved = session.view(viewId + ':' + currentPath);
			if (saved) codeEditor.restoreViewState(saved);
		}
		if (model.getValue() !== source) model.setValue(source);
		codeEditor.updateOptions({
			ariaLabel: label,
			readOnly: readonly || disabled,
			domReadOnly: readonly || disabled
		});
	});
	$effect(() => {
		const target = location;
		const codeEditor = instance;
		if (!target || !codeEditor) return;
		codeEditor.setPosition({ lineNumber: target.line, column: target.column });
		codeEditor.revealPositionInCenter({ lineNumber: target.line, column: target.column });
		codeEditor.focus();
	});
</script>

<div class="source-editor" data-model-uri={modelUri}>
	<div class="source-body" {@attach attach}></div>
	{#if loadError}<p role="alert">{loadError}</p>{/if}
	<footer>
		<span>{language}{readonly ? ' · 읽기 전용' : ''}</span><span
			>줄 {position.lineNumber}, 열 {position.column}</span
		>
	</footer>
</div>

<style>
	.source-editor {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		min-width: 0;
	}
	.source-body {
		flex: 1;
		min-height: 0;
		min-width: 0;
		overflow: hidden;
	}
	footer {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		padding: 7px 15px;
		border-top: 1px solid var(--border);
		font-size: 10px;
		color: var(--text-muted);
	}
	p {
		padding: 12px;
	}
</style>
