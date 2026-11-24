import { expect, it } from 'vitest';

import { canonicalReleaseContent, hashGameReleaseContent } from '../release-content.js';
import { validateGameReleaseContent } from '../versioning-validation.js';
import cases from './fixtures/content-cases.json';
import minimal from './fixtures/minimal-release.json';
import { verifyReleaseContent } from './verify.js';

const ids = { gameId: 'installation', sessionId: 'session', now: minimal.createdAt };

it.each(cases)('shared host content fixture: $name', async ({ request, expect: expected }) => {
	const result = verifyReleaseContent(request.release, ids);
	if (!expected.accepted) {
		await expect(result).rejects.toMatchObject({ code: expected.errorCode });
		return;
	}
	const verified = await result;
	expect(verified.content).toEqual(expected.normalizedContent);
	expect(verified.contentHash).toBe(expected.contentHash);
	expect(
		await verifyReleaseContent({ ...request.release, content: verified.content }, ids)
	).toEqual(verified);
});

it('keeps creator maps, signed zero, surrogates and floating point values in the existing digest', async () => {
	const fixture = cases.find((row) => row.name === 'creator keys surrogates and IEEE754')!;
	const content = (await verifyReleaseContent(fixture.request.release, ids)).content;
	content.initialState['😀'] = -0;
	content.initialState.large = Number('9007199254740993');
	expect(await hashGameReleaseContent(content)).toBe(fixture.expect.contentHash);
	expect(canonicalReleaseContent(content)).toContain('\\ud800');
});

it('bounds raw nodes before unknown fields can be stripped by normalization', async () => {
	const atLimit = Array.from({ length: 99999 }, () => null);
	expect(() => validateGameReleaseContent(atLimit)).not.toThrow();
	await expect(
		verifyReleaseContent({ ...minimal, content: { unknown: atLimit } }, ids)
	).rejects.toMatchObject({ code: 'content' });
});

it('bounds original depth and strings before the model parser', async () => {
	let nested: unknown = null;
	for (let depth = 0; depth < 64; depth++) {
		nested = [nested];
	}
	expect(() => validateGameReleaseContent(nested)).not.toThrow();
	await expect(verifyReleaseContent({ ...minimal, content: [nested] }, ids)).rejects.toMatchObject({
		code: 'content'
	});
	expect(() => validateGameReleaseContent('x'.repeat(16 * 1024 * 1024))).not.toThrow();
	await expect(
		verifyReleaseContent({ ...minimal, content: 'x'.repeat(16 * 1024 * 1024 + 1) }, ids)
	).rejects.toMatchObject({ code: 'content' });
});

it('does not reveal internal exception details', async () => {
	await expect(verifyReleaseContent({ ...minimal, content: null }, ids)).rejects.toMatchObject({
		name: 'GamePackageError',
		message: '게임 패키지 형식이 올바르지 않아요.'
	});
});
