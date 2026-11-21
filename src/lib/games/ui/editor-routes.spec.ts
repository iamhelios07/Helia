import { expect, it } from 'vitest';

import {
	documentFromRoute,
	documentRoutePath,
	editorAssetNames,
	encodeEditorPath
} from './editor-routes.js';

const files = {
	code: { 'main.ts': true, 'logic/ai.ts': true, 'style.css': true },
	assets: { luka: '인물/루카 #1%.png' }
};

it.each([
	['game.json', 'info'],
	['instructions.json', 'instructions'],
	['state.json', 'state'],
	['lorebook.json', 'lorebook'],
	['regex.json', 'regex'],
	['code/main.ts', 'code:main.ts'],
	['code/logic/ai.ts', 'code:logic/ai.ts'],
	['code/style.css', 'code:style.css'],
	['assets/인물/루카 #1%.png', 'asset:luka'],
	['.helia/GameState.d.ts', 'types:GameState'],
	['.helia/runtime.d.ts', 'types:HeliaRuntime']
] as const)('maps %s to a document and back', (path, id) => {
	expect(documentFromRoute(path, files)).toBe(id);
	expect(documentRoutePath(id, files)).toBe(path);
});

it('rejects unknown documents and matches stable assets against their current visible filename', () => {
	for (const path of [
		'unknown',
		'code/missing.ts',
		'assets/luka',
		'assets/../luka',
		'__proto__',
		'toString'
	]) {
		expect(documentFromRoute(path, files)).toBeNull();
	}
	expect(documentRoutePath('code:missing.ts', files)).toBeNull();
	expect(documentRoutePath('asset:toString', files)).toBeNull();
	expect(documentRoutePath(null, files)).toBe('');
	const renamed = { ...files, assets: { luka: '캐릭터/루카.png' } };
	expect(documentRoutePath('asset:luka', renamed)).toBe('assets/캐릭터/루카.png');
	expect(documentFromRoute('assets/인물/루카 #1%.png', renamed)).toBeNull();
});

it('encodes each segment once, retaining directories and literal percent signs', () => {
	const path = 'assets/인물/루카 #1%.png';
	const encoded = encodeEditorPath(path);
	expect(encoded).toContain('/');
	expect(encoded).toContain('%23');
	expect(encoded).toContain('%25');
	expect(decodeURIComponent(encoded)).toBe(path);
	expect(decodeURIComponent(encodeEditorPath('assets/%2F.png'))).toBe('assets/%2F.png');
});

it('reads only file names from possibly incomplete editor content', () => {
	expect(editorAssetNames('{')).toEqual({});
	expect(editorAssetNames('[]')).toEqual({});
	expect(editorAssetNames('{"a":{"name":"a.png","data":"opaque"},"b":null}')).toEqual({
		a: 'a.png'
	});
});
