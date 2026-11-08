import { expect, it } from 'vitest';

import { readAuthoringBundle, writeAuthoringBundle } from './code-authoring.js';

it('edits decoded source without escaping it and preserves UI presentation options', () => {
	const source = `const label = "a\\nb";\nconst close = '</script>';\n`;
	const input = JSON.stringify({
		version: 1,
		entry: 'main.tsx',
		modules: { 'main.tsx': { language: 'tsx', source } },
		chatDock: 'bottom',
		chatRatio: 0.4,
		chatStyle: { color: '#fff' },
		layout: { kind: 'panel', id: 'main' }
	});
	const bundle = readAuthoringBundle(input, 'ui')!;
	expect(bundle.modules['main.tsx'].source).toBe(source);
	const result = JSON.parse(
		writeAuthoringBundle(bundle, 'ui', {
			...bundle.modules,
			'main.tsx': { language: 'tsx', source: source + '// changed\n' }
		})
	);
	expect(result.modules['main.tsx'].source).toBe(source + '// changed\n');
	expect(result).toMatchObject({
		chatDock: 'bottom',
		chatRatio: 0.4,
		chatStyle: { color: '#fff' },
		layout: { kind: 'panel', id: 'main' }
	});
	expect(() => readAuthoringBundle('{unfinished', 'ui')).toThrow();
	expect(readAuthoringBundle('null', 'ui')).toBeNull();
});
