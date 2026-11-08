import { expect, it } from 'vitest';
import { parseResources, renameResourceFolder, validateResourcePath } from './resources.js';
it('validates portable inert resources and rejects unsafe names, SVG and URLs', () => {
	const resource = { name: 'Portrait', mime: 'image/png', data: 'data:image/png;base64,aGVsbG8=' };
	expect(parseResources({ portrait: resource })).toEqual({ portrait: resource });
	for (const value of [
		{ portrait: { ...resource, mime: 'image/svg+xml' } },
		{ portrait: { ...resource, data: 'https://example.com/image.png' } },
		{ portrait: { ...resource, data: 'data:image/png;base64,invalid' } },
		JSON.parse('{"__proto__":{}}')
	])
		expect(() => parseResources(value)).toThrow();
});

it('supports relative asset paths and rejects ambiguous paths before saving', () => {
	const resource = {
		name: 'images/초상화.png',
		mime: 'image/png',
		data: 'data:image/png;base64,aGVsbG8='
	};
	expect(parseResources({ portrait: resource }).portrait.name).toBe('images/초상화.png');
	for (const name of [
		'/image.png',
		'../image.png',
		'images/../image.png',
		'images//image.png',
		'images/',
		'C:/image.png',
		'images\\image.png',
		'images/\u0000.png'
	]) {
		expect(() => validateResourcePath(name)).toThrow();
	}
	expect(() => parseResources({ first: resource, second: resource })).toThrow('같은 경로');
	expect(() =>
		parseResources({ first: { ...resource, name: 'images' }, second: resource })
	).toThrow('파일과 폴더');
	expect(() =>
		parseResources({ first: { ...resource, name: 'second' }, second: resource })
	).toThrow('참조');
});

it('renames nested asset directories atomically while preserving stable references and bytes', () => {
	const portrait = {
		name: 'images/characters/hero.png',
		mime: 'image/png',
		data: 'data:image/png;base64,aGVsbG8='
	};
	const source = { portrait, sound: { ...portrait, name: 'audio/theme.png' } };
	const renamed = renameResourceFolder(source, 'images', 'art');
	expect(renamed.portrait).toEqual({ ...portrait, name: 'art/characters/hero.png' });
	expect(renamed.sound).toEqual(source.sound);
	expect(source.portrait.name).toBe('images/characters/hero.png');
	expect(() =>
		renameResourceFolder(
			{ ...source, occupied: { ...portrait, name: 'art/characters/hero.png' } },
			'images',
			'art'
		)
	).toThrow();
});
