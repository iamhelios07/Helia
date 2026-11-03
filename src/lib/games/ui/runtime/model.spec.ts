import { describe, expect, it } from 'vitest';
import { parseGameUI, parsePanelLayout } from './model.js';
import { dockPanel, panelIds, reconcileLayout, removePanel } from './layout.js';
import { compileGameUI } from './compiler.js';

const ui = {
	version: 1,
	entry: 'main.tsx',
	modules: {
		'main.tsx': {
			language: 'tsx',
			source: `import { h } from 'preact'; import { registerPanel } from '@helia/ui'; registerPanel({id:'main',title:'Main',component:()=> <p>Hello</p>});`
		}
	}
} as const;
describe('game UI contracts and compilation', () => {
	it('validates packaged multi-module UI and optional creator defaults', () => {
		expect(
			parseGameUI({
				...ui,
				chatDock: 'bottom',
				chatRatio: 0.4,
				chatStyle: { fontFamily: 'serif', background: '#123456' }
			}).chatDock
		).toBe('bottom');
		for (const bad of [
			{ ...ui, entry: 'missing.tsx' },
			{ ...ui, chatRatio: NaN },
			{ ...ui, chatStyle: { background: 'url(https://example.com)' } },
			{ ...ui, modules: { '../escape.tsx': ui.modules['main.tsx'] } },
			{ ...ui, version: 2 }
		])
			expect(() => parseGameUI(bad)).toThrow();
	});
	it('rejects duplicate, oversized or deeply nested layouts', () => {
		const leaf = { kind: 'panel', id: 'same' };
		expect(() =>
			parsePanelLayout({ kind: 'split', axis: 'horizontal', ratio: 0.5, first: leaf, second: leaf })
		).toThrow();
		expect(() =>
			parsePanelLayout({
				kind: 'split',
				axis: 'horizontal',
				ratio: Infinity,
				first: leaf,
				second: { kind: 'panel', id: 'other' }
			})
		).toThrow();
	});
	it('preserves surviving placement, supports docking, and fits sixteen registrations within depth limits', () => {
		const original = reconcileLayout(null, ['a', 'b'])!;
		const moved = dockPanel(original, 'b', 'a', 'bottom');
		expect(moved).toMatchObject({
			kind: 'split',
			axis: 'vertical',
			first: { id: 'a' },
			second: { id: 'b' }
		});
		expect(removePanel(moved, 'a')).toEqual({ kind: 'panel', id: 'b' });
		expect(reconcileLayout(moved, ['a', 'b'])).toEqual(moved);
		const all = reconcileLayout(
			null,
			Array.from({ length: 16 }, (_, index) => `panel${index}`)
		);
		expect(panelIds(parsePanelLayout(all))).toHaveLength(16);
	});
	it('compiles TSX and packaged imports without eval or external script loading', async () => {
		const html = await compileGameUI(ui, 'test-token');
		expect(html).toContain("connect-src 'none'");
		expect(html).toContain('test-token');
		expect(html).not.toMatch(/<script[^>]+src=/);
		expect(html).not.toContain('new Function(');
		const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
		expect(() => new Function(script)).not.toThrow();
	});
	it('uses declared JSX/TSX language even when the packaged module has no extension', async () => {
		await expect(
			compileGameUI(
				{
					version: 1,
					entry: 'main',
					modules: {
						main: {
							language: 'tsx',
							source:
								'const text: string = "ok"; export default function(){helia.registerPanel({id:"main",title:"Main",component:()=> <p>{text}</p>});}'
						}
					}
				},
				'token'
			)
		).resolves.toContain('Main');
	});
	it.each([
		`import x from 'https://example.com/x.js';`,
		`import x from '../outside';`,
		`import('preact');`,
		`const x = require('preact');`
	])('rejects unresolved and dynamic imports: %s', async (source) => {
		await expect(
			compileGameUI({ ...ui, modules: { 'main.tsx': { language: 'tsx', source } } }, 'token')
		).rejects.toThrow();
	});
	it('prevents authored strings from closing the inline script element', async () => {
		const html = await compileGameUI(
			{
				...ui,
				modules: {
					'main.tsx': {
						language: 'tsx',
						source: `const text = '</script><script>outside()</script>';`
					}
				}
			},
			'token'
		);
		expect(html).toContain('<\\/script>');
		expect(html.match(/<\/script>/g)).toHaveLength(1);
	});
});
