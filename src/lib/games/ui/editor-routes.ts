import type { DocumentId } from './editor-workspace.svelte.js';

const documents: Record<string, DocumentId> = {
	'game.json': 'info',
	'instructions.json': 'instructions',
	'state.json': 'state',
	'lorebook.json': 'lorebook',
	'regex.json': 'regex',
	'.helia/GameState.d.ts': 'types:GameState',
	'.helia/runtime.d.ts': 'types:HeliaRuntime'
};

export interface EditorRouteFiles {
	code: Readonly<Record<string, unknown>>;
	assets: Readonly<Record<string, string>>;
}

/** Route parameters are already decoded by SvelteKit. Match only existing authored files. */
export function documentFromRoute(path: string, files: EditorRouteFiles): DocumentId | null {
	if (Object.hasOwn(documents, path)) {
		return documents[path];
	}
	if (path.startsWith('code/') && Object.hasOwn(files.code, path.slice(5))) {
		return `code:${path.slice(5)}`;
	}
	if (path.startsWith('assets/')) {
		const id = Object.keys(files.assets).find((id) => files.assets[id] === path.slice(7));
		return id ? `asset:${id}` : null;
	}
	return null;
}

/** Assets use their visible filename while editor tabs retain their stable resource ID. */
export function documentRoutePath(id: DocumentId | null, files: EditorRouteFiles): string | null {
	if (id === null) {
		return '';
	}
	if (id.startsWith('code:')) {
		return Object.hasOwn(files.code, id.slice(5)) ? `code/${id.slice(5)}` : null;
	}
	if (id.startsWith('asset:')) {
		const name = Object.hasOwn(files.assets, id.slice(6)) ? files.assets[id.slice(6)] : undefined;
		return name ? `assets/${name}` : null;
	}
	return Object.keys(documents).find((path) => documents[path] === id) ?? null;
}

export function encodeEditorPath(path: string): string {
	return path.split('/').map(encodeURIComponent).join('/');
}

/** Read names without repeatedly validating/decoding embedded media bytes during navigation. */
export function editorAssetNames(source: string): Record<string, string> {
	try {
		const value: unknown = JSON.parse(source);
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return {};
		}
		return Object.fromEntries(
			Object.entries(value).flatMap(([id, asset]) =>
				asset && typeof asset === 'object' && 'name' in asset && typeof asset.name === 'string'
					? [[id, asset.name]]
					: []
			)
		);
	} catch {
		return {};
	}
}
