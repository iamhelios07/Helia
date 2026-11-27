import { expect, it } from 'vitest';

import type { GameReleaseContent } from './versioning.js';

import fixture from '../storage/fixtures/media-identity.json';
import releases from '../testing/fixtures/game-releases.json';
import {
	hashGameReleaseContent,
	hashGameReleaseContentStream,
	type ReleaseByteSource
} from './release-content.js';

const cases = fixture.vectors.flatMap((vector) =>
	fixture.chunkSizes.map((size) => ({ ...vector, size }))
);

it.each(cases)('streams shared release vector: $length bytes / $size chunks', async (vector) => {
	const bytes = Uint8Array.from({ length: vector.length }, (_, index) => (index * 37 + 11) % 256);
	const content = structuredClone(fixture.releaseTemplate) as unknown as GameReleaseContent;
	content.resources!.media.data = `data:${fixture.mime};base64,${Buffer.from(bytes).toString('base64')}`;
	expect(await hashGameReleaseContent(content)).toBe(vector.releaseHash);
	expect(await hashGameReleaseContentStream(content)).toBe(vector.releaseHash);
	content.resources!.media.data = 'helia-asset:fixture-media';
	const resolve = async function* (reference: string) {
		expect(reference).toBe('helia-asset:fixture-media');
		yield new Uint8Array(0);
		for (let offset = 0; offset < bytes.length; offset += vector.size) {
			yield bytes.subarray(offset, offset + vector.size);
		}
	};
	expect(await hashGameReleaseContentStream(content, resolve)).toBe(vector.releaseHash);
});

it.each(releases)('preserves existing canonical fixture: $name', async (vector) => {
	const content = vector.content as unknown as GameReleaseContent;
	expect(await hashGameReleaseContentStream(content)).toBe(vector.hash);
	const referenced = structuredClone(content);
	const assets = new Map<string, Uint8Array>();
	for (const [id, resource] of Object.entries(referenced.resources ?? {})) {
		assets.set(`helia-asset:${id}`, Buffer.from(resource.data.split(',')[1], 'base64'));
		resource.data = `helia-asset:${id}`;
	}
	expect(
		await hashGameReleaseContentStream(referenced, (reference) => [assets.get(reference)!])
	).toBe(vector.hash);
});

it('keeps JSON escaping and surrogate pairs identical across string block boundaries', async () => {
	const content = structuredClone(fixture.releaseTemplate) as unknown as GameReleaseContent;
	content.description = 'x'.repeat(4095) + '🎮' + '\ud800' + '\u0000\n"\\' + '한'.repeat(5000);
	expect(await hashGameReleaseContentStream(content)).toBe(await hashGameReleaseContent(content));
});

it('propagates missing and failed byte suppliers', async () => {
	const content = structuredClone(fixture.releaseTemplate) as unknown as GameReleaseContent;
	content.resources!.media.data = 'helia-asset:missing';
	await expect(hashGameReleaseContentStream(content)).rejects.toThrow('unavailable');
	await expect(
		hashGameReleaseContentStream(content, () => {
			throw Error('read failed');
		})
	).rejects.toThrow('read failed');
});

it.each(['abc', [1, 2, 3], new Uint16Array([1]), null, undefined])(
	'rejects invalid byte supplier chunks: %s',
	async (chunk) => {
		const content = structuredClone(fixture.releaseTemplate) as unknown as GameReleaseContent;
		content.resources!.media.data = 'helia-asset:invalid';
		const resolve = async function* () {
			yield new Uint8Array([1]);
			yield chunk;
		};
		await expect(
			hashGameReleaseContentStream(content, () => resolve() as unknown as ReleaseByteSource)
		).rejects.toThrow('Release asset chunk must be a Uint8Array');
	}
);
