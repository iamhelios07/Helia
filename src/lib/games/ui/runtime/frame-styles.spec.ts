import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

import { FRAME_STYLES } from './frame-styles.js';

/**
 * The frame embeds its base styles as text because `?raw` on `.css` files resolves
 * empty in server contexts (see frame-styles.ts). This test is the drift guard:
 * the shared layer (everything above the frame-only marker) must match the app
 * stylesheet declaration by declaration, and the frame must not reintroduce
 * retired colors.
 */
it('keeps the embedded frame base identical to the app stylesheet', () => {
	const app = readFileSync(new URL('../../../../app.css', import.meta.url), 'utf8');
	const shared = FRAME_STYLES.split('/* Frame-only layout rules')[0];
	const declarations = shared
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.includes(':') && !line.startsWith('/*') && !line.endsWith('{'));
	for (const declaration of declarations) {
		expect(app, `frame style missing from app.css: ${declaration}`).toContain(declaration);
	}
	for (const retired of ['#17151e', '#201c29', '#302b3e', '#514960', '#b6a1ff', '#e6e3ed']) {
		expect(FRAME_STYLES).not.toContain(retired);
	}
});
