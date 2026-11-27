import type { Game } from './model.js';
import type { GameReleaseContent } from './versioning.js';

import { Base64Stream } from '../storage/media-identity.js';
import { parseResources } from './resources.js';
import { Sha256 } from './state/sha256.js';

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

export type ReleaseByteSource = Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
/** Called only for references at resources[*].data; failures propagate to the caller. */
export type ReleaseByteResolver = (
	reference: string
) => ReleaseByteSource | Promise<ReleaseByteSource>;

class ReleaseDigestWriter {
	private hash = new Sha256();
	private encoder = new TextEncoder();

	constructor(private resolve?: ReleaseByteResolver) {}

	write(text: string): void {
		this.hash.update(this.encoder.encode(text));
	}

	// Chunk before JSON escaping, keeping surrogate pairs intact at chunk boundaries.
	private string(value: string): void {
		this.write('"');
		for (let offset = 0; offset < value.length;) {
			let end = Math.min(offset + 4096, value.length);
			const last = value.charCodeAt(end - 1);
			if (end < value.length && last >= 0xd800 && last <= 0xdbff) {
				end--;
			}
			this.write(JSON.stringify(value.slice(offset, end)).slice(1, -1));
			offset = end;
		}
		this.write('"');
	}

	private async media(reference: string, mime: string): Promise<void> {
		if (!this.resolve) {
			throw Error('Release asset unavailable');
		}
		this.write('["string",');
		this.write(JSON.stringify(`data:${mime};base64,`).slice(0, -1));
		const base64 = new Base64Stream((text) => this.write(text));
		for await (const bytes of await this.resolve(reference)) {
			if (!(bytes instanceof Uint8Array)) {
				throw Error('Release asset chunk must be a Uint8Array');
			}
			base64.update(bytes);
		}
		base64.finish();
		this.write('"]');
	}

	private async object(value: object, path: string[]): Promise<void> {
		this.write('["object",[');
		const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : Number(a > b)));
		for (const [index, [key, item]] of entries.entries()) {
			this.write(index ? ',[' : '[');
			this.string(key);
			this.write(',');
			await this.property({ key, item, parent: value, path });
			this.write(']');
		}
		this.write(']]');
	}

	private async property(entry: {
		key: string;
		item: unknown;
		parent: object;
		path: string[];
	}): Promise<void> {
		const { key, item, parent, path } = entry;
		if (
			path.length === 2 &&
			path[0] === 'resources' &&
			key === 'data' &&
			typeof item === 'string' &&
			item.startsWith('helia-asset:')
		) {
			const mime: unknown = Reflect.get(parent, 'mime');
			if (typeof mime !== 'string') {
				throw Error('Release asset MIME unavailable');
			}
			await this.media(item, mime);
			return;
		}
		await this.value(item, [...path, key]);
	}

	async value(value: unknown, path: string[] = []): Promise<void> {
		if (typeof value === 'string') {
			this.write('["string",');
			this.string(value);
			this.write(']');
			return;
		}
		if (Array.isArray(value)) {
			this.write('["array",[');
			for (const [index, item] of value.entries()) {
				this.write(index ? ',' : '');
				await this.value(item, [...path, String(index)]);
			}
			this.write(']]');
			return;
		}
		if (typeof value === 'object' && value !== null) {
			await this.object(value, path);
			return;
		}
		this.write(JSON.stringify(canonicalTree(value)));
	}

	digest(): string {
		return this.hash.digest();
	}
}

/** Same typed canonical digest, without building a second tree or a whole data URI. */
export async function hashGameReleaseContentStream(
	content: GameReleaseContent,
	resolve?: ReleaseByteResolver
): Promise<string> {
	const writer = new ReleaseDigestWriter(resolve);
	await writer.value(content);
	return writer.digest();
}
