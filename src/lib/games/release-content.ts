import type { Game } from './model.js';
import type { GameReleaseContent } from './versioning.js';

import { parseResources } from './resources.js';

type AssetResolver = (reference: string) => string;

/** Source projects are authoritative; generated scripts/UI cannot affect a release digest. */
export function gameReleaseContent(game: Game, resolve?: AssetResolver): GameReleaseContent {
	const content: GameReleaseContent = {
		title: game.title,
		genre: game.genre,
		description: game.description,
		settings: game.settings,
		schema: game.schema,
		initialState: game.initialState,
		...(game.ai ? { ai: game.ai } : {}),
		regex: game.regex ?? [],
		resources: portableResources(game, resolve)
	};
	if (game.code) {
		content.code = game.code;
	} else {
		content.scripts = Object.fromEntries(
			Object.entries(game.scripts).map(([id, script]) => [
				id,
				{ language: script.language, source: script.source }
			])
		);
		if (game.ui) {
			const ui = { ...game.ui };
			delete ui.compiled;
			delete ui.artifact;
			content.ui = ui;
		}
	}
	return structuredClone(content);
}

function portableResources(game: Game, resolve?: AssetResolver) {
	return parseResources(
		Object.fromEntries(
			Object.entries(game.resources ?? {}).map(([id, asset]) => {
				const data = asset.data.startsWith('helia-asset:') ? resolve?.(asset.data) : asset.data;
				if (!data?.startsWith(`data:${asset.mime};base64,`)) {
					throw Error('Release asset unavailable');
				}
				const encoded = data.slice(data.indexOf(',') + 1);
				// Decode actual bytes and normalize the encoding rather than hashing a transport reference.
				return [id, { ...asset, data: `data:${asset.mime};base64,${btoa(atob(encoded))}` }];
			})
		)
	);
}

/** Typed canonical tree: UTF-16 sorted keys, IEEE-754 numbers, no host JSON number formatting. */
function canonicalTree(value: unknown): unknown {
	if (value === null) {
		return ['null'];
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw Error('Non-finite release number');
		}
		const bytes = new Uint8Array(8);
		new DataView(bytes.buffer).setFloat64(0, value === 0 ? 0 : value);
		return ['number', Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')];
	}
	if (typeof value === 'string' || typeof value === 'boolean') {
		return [typeof value, value];
	}
	if (Array.isArray(value)) {
		return ['array', value.map(canonicalTree)];
	}
	if (typeof value === 'object' && value) {
		return [
			'object',
			Object.entries(value)
				.sort(([a], [b]) => (a < b ? -1 : Number(a > b)))
				.map(([key, item]) => [key, canonicalTree(item)])
		];
	}
	throw Error('Invalid release content');
}
export function canonicalReleaseContent(content: GameReleaseContent): string {
	return JSON.stringify(canonicalTree(content));
}
export async function hashGameReleaseContent(content: GameReleaseContent): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(canonicalReleaseContent(content))
	);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
