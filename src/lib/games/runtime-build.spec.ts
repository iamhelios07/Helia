import { expect, it } from 'vitest';

import { parseScripts } from './model.js';
import { buildRuntime } from './runtime-build.js';
import { runtimeReady } from './runtime-ready.js';
import legacy from './state/fixtures/legacy-build.json';
import { contentHash } from './state/model.js';
import { parseStateDocument } from './state/schema.js';
import { parseGameUI } from './ui/runtime/model.js';

it('accepts old FNV cache keys and regenerates derived builds on the next build', async () => {
	const { schema } = parseStateDocument({ schema: legacy.schema, initialState: {} });
	const input = { schema, scripts: parseScripts(legacy.scripts), ui: parseGameUI(legacy.ui) };
	expect(runtimeReady(input)).toBe(true);
	const built = await buildRuntime(input);
	expect(built.scripts.main.source).toBe(legacy.scripts.main.source);
	expect(built.scripts.main.compiled).not.toBe(legacy.scripts.main.compiled);
	expect(built.scripts.main.compiledFor).toBe(contentHash([legacy.scripts.main.source, schema]));
	expect(built.scripts.main.compiledFor).not.toBe(legacy.scripts.main.compiledFor);
	expect(built.ui.compiled?.sourceHash).toBe(contentHash([legacy.ui.entry, legacy.ui.modules]));
	expect(built.ui.compiled?.factories).not.toBe(legacy.ui.compiled.factories);
	expect(input.ui.compiled?.sourceHash).toBe(legacy.ui.compiled.sourceHash);
	const reused = await buildRuntime(built);
	expect(reused.scripts).toEqual(built.scripts);
	expect(reused.ui.compiled).toBe(built.ui.compiled);
});
