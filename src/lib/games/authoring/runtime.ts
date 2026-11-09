/**
 * The authoring declarations live in `runtime.d.ts` so editors can open the
 * real file instead of a string. The sandbox resolves it at `.helia/runtime.d.ts`,
 * where `../GameState` is the declaration generated from the game's state schema.
 */
import declarations from './runtime.d.ts?raw';

export const HELIA_AUTHORING_DECLARATIONS: string = declarations;
