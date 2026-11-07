import { expect, it } from 'vitest';
import { parseResources } from './resources.js';
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
