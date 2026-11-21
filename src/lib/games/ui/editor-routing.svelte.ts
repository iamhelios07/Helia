import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { onDestroy, untrack } from 'svelte';

import type { DocumentId, EditorWorkspace } from './editor-workspace.svelte.js';

import {
	documentFromRoute,
	documentRoutePath,
	editorAssetNames,
	encodeEditorPath,
	type EditorRouteFiles
} from './editor-routes.js';

/** Keeps the retained editor instance and the current document URL in sync. */
export class EditorRouting {
	error = $state('');
	private seenRoute: string | undefined;
	private document: DocumentId | null = null;
	private selectedPath: string | null = null;
	private replace = false;
	private sequence = 0;
	private disposed = false;
	private assetSource = '';
	private assets: Record<string, string> = {};

	constructor(
		private editor: EditorWorkspace,
		private readPath: () => string | undefined
	) {
		$effect(() => {
			const path = readPath();
			if (path === undefined || editor.loading || !editor.draft || editor.recoveryError) {
				return;
			}
			const files = this.files();
			const active = editor.activeDocument;
			const selected = documentRoutePath(active, files);
			untrack(() => this.sync(path, active, selected, files));
		});
		onDestroy(() => {
			this.disposed = true;
			++this.sequence;
		});
	}

	private files(): EditorRouteFiles {
		const source = this.editor.draft?.documents.assets ?? '{}';
		if (source !== this.assetSource) {
			this.assetSource = source;
			this.assets = editorAssetNames(source);
		}
		return {
			code: this.editor.codeProject?.files ?? {},
			assets: this.assets
		};
	}

	private sync(
		path: string,
		active: DocumentId | null,
		selected: string | null,
		files: EditorRouteFiles
	) {
		if (path !== this.seenRoute) {
			const initial = this.seenRoute === undefined;
			this.accept(path, files, initial);
			if (initial && !path) {
				this.write('game.json', true);
			}
			return;
		}
		if (active !== this.document || selected !== this.selectedPath) {
			if (selected === null) {
				this.accept(path, files, false);
				return;
			}
			const replace = this.replace || active === this.document;
			this.document = active;
			this.selectedPath = selected;
			this.replace = false;
			this.error = '';
			this.write(selected, replace);
			return;
		}
		// A formerly missing file may have been restored in the current draft.
		if (path && !active && documentFromRoute(path, files)) {
			this.accept(path, files, false);
		}
	}

	private accept(path: string, files: EditorRouteFiles, initial: boolean) {
		this.seenRoute = path;
		let id: DocumentId | null = null;
		if (path) {
			id = documentFromRoute(path, files);
		} else if (initial) {
			id = 'info';
		}
		this.error =
			path && !id ? '요청한 파일을 찾을 수 없어요. 탐색기에서 다른 파일을 선택해주세요.' : '';
		if (id && this.editor.activeDocument !== id) {
			this.editor.openDocument(id);
		} else if (!id) {
			this.editor.activeDocument = null;
			this.editor.codeSelection = null;
		}
		this.document = this.editor.activeDocument;
		this.selectedPath = documentRoutePath(this.document, files);
		this.replace = false;
	}

	private write(path: string, replaceState: boolean) {
		const sequence = ++this.sequence;
		void this.navigate(path, replaceState).catch(() => {
			if (!this.disposed && sequence === this.sequence) {
				this.accept(this.readPath() ?? '', this.files(), false);
				this.error = '파일 주소로 이동하지 못했어요. 다시 선택해주세요.';
			}
		});
	}

	private async navigate(path: string, replaceState: boolean) {
		const id = encodeURIComponent(this.editor.gameId);
		const options = { replace: replaceState, reset: false };
		if (path) {
			await goto(
				resolve('/games/[id]/edit/[...document]', { id, document: encodeEditorPath(path) }),
				options
			);
		} else {
			await goto(resolve('/games/[id]/edit', { id }), options);
		}
	}

	replaceSelection() {
		this.replace = true;
	}

	/** Internal document navigation never leaves this editor or flushes a draft on each tab click. */
	contains(url: URL | undefined): boolean {
		if (this.readPath() === undefined || !url || url.origin !== window.location.origin) {
			return false;
		}
		const base = resolve('/games/[id]/edit', { id: encodeURIComponent(this.editor.gameId) });
		return url.pathname === base || url.pathname.startsWith(base + '/');
	}
}
