import hooks from '../../../../node_modules/preact/hooks/src/index.d.ts?raw';
import dom from '../../../../node_modules/preact/src/dom.d.ts?raw';
import preact from '../../../../node_modules/preact/src/index.d.ts?raw';
import jsx from '../../../../node_modules/preact/src/jsx.d.ts?raw';
/**
 * The authoring declarations live in `runtime.d.ts` so editors can open the
 * real file instead of a string. The sandbox resolves it at `.helia/runtime.d.ts`,
 * where `./GameState` is the declaration generated from the game's state schema.
 */
import declarations from './runtime.d.ts?raw';

export const HELIA_AUTHORING_DECLARATIONS: string = declarations;

/** Ship the installed Preact types, including DOM event and JSX attribute contracts. */
export const HELIA_AUTHORING_LIBRARIES: Record<string, string> = {
	'node_modules/preact/index.d.ts': "export * from './src/index';",
	'node_modules/preact/src/index.d.ts': preact,
	'node_modules/preact/src/dom.d.ts': dom,
	'node_modules/preact/src/jsx.d.ts': jsx,
	'node_modules/preact/hooks/index.d.ts': "export * from './src/index';",
	'node_modules/preact/hooks/src/index.d.ts': hooks
};
