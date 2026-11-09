/*
 * Authoring API for the game sandbox.
 *
 * This file is copied verbatim into the editing project as `.helia/runtime.d.ts`
 * and is excluded from the application type program, because its ambient
 * declarations only belong to the sandbox. `../GameState` there is the
 * declaration generated from the game's state schema.
 */

type GameState = import('../GameState').GameState;
type JsonValue =
	null | boolean | number | string | readonly JsonValue[] | { [key: string]: JsonValue };
type ReadonlyState<T> = {
	readonly [K in keyof T]: T[K] extends object ? ReadonlyState<T[K]> : T[K];
};

interface ActionContext<TArgs extends object = Record<string, JsonValue>> {
	state: GameState;
	args: ReadonlyState<TArgs>;
}
interface ReadContext<TArgs extends object = Record<string, JsonValue>> {
	state: ReadonlyState<GameState>;
	args: ReadonlyState<TArgs>;
}
interface ActionDefinition<TArgs extends object = Record<string, JsonValue>> {
	name: string;
	arguments?: object;
	description?: string;
	ai?: boolean;
	run(context: ActionContext<TArgs>): GameState;
}
interface QueryDefinition<TArgs extends object = Record<string, JsonValue>> {
	name: string;
	arguments?: object;
	description?: string;
	ai?: boolean;
	run(context: ReadContext<TArgs>): JsonValue;
}
interface RuleDefinition {
	name: string;
	priority?: number;
	actions?: string[];
	mode?: 'included' | 'independent';
	run(context: ReadContext): unknown;
}
interface HeliaRuntime {
	defineAction<TArgs extends object = Record<string, JsonValue>>(
		definition: ActionDefinition<TArgs>
	): void;
	defineQuery<TArgs extends object = Record<string, JsonValue>>(
		definition: QueryDefinition<TArgs>
	): void;
	defineFilter(definition: RuleDefinition): void;
	defineHook(definition: RuleDefinition): void;
	emit(name: string, payload?: JsonValue): void;
	requestAI(text: string, options?: { visible?: boolean }): void;
	asset(id: string): string;
	getState(): ReadonlyState<GameState>;
	action(name: string, args?: JsonValue): Promise<unknown>;
	transaction(
		action: { name: string; args: Record<string, JsonValue> },
		state: GameState
	): Promise<unknown>;
	ai(text: string, options?: { visible?: boolean }): Promise<unknown>;
	registerPanel(panel: { id: string; title: string; component: () => unknown }): () => void;
	subscribeState(listener: (state: ReadonlyState<GameState>) => void): () => void;
}

declare const helia: HeliaRuntime;
declare namespace JSX {
	type Element = unknown;
	interface IntrinsicElements {
		[name: string]: Record<string, unknown>;
	}
}

declare module '@helia/state' {
	export type GameState = import('../GameState').GameState;
}
declare module '@helia/ui' {
	export const helia: HeliaRuntime;
	export function useGameState(): ReadonlyState<GameState>;
	export function getState(): ReadonlyState<GameState>;
	export function useUIState<T>(
		key: string,
		initial: T
	): [T, (next: T | ((previous: T) => T)) => void];
	export function useUIEvent(event: string, listener: (payload: JsonValue) => void): void;
	export function onEvent(event: string, listener: (payload: JsonValue) => void): () => void;
	export function onDispose(dispose: () => void): () => void;
	export const registerPanel: typeof helia.registerPanel;
	export const subscribeState: typeof helia.subscribeState;
	export const action: typeof helia.action;
	export const transaction: typeof helia.transaction;
	export const ai: typeof helia.ai;
	export const asset: typeof helia.asset;
	export function Button(props: Record<string, unknown>): JSX.Element;
	export function Text(props: Record<string, unknown>): JSX.Element;
	export function Progress(props: Record<string, unknown>): JSX.Element;
	export function Inventory(props: Record<string, unknown>): JSX.Element;
	export function Stats(props: Record<string, unknown>): JSX.Element;
	export function QuestList(props: Record<string, unknown>): JSX.Element;
}
declare module 'preact' {
	export function h(type: unknown, props: unknown, ...children: unknown[]): JSX.Element;
	export const Fragment: unknown;
}
declare module 'preact/hooks' {
	export function useState<T>(
		initial: T | (() => T)
	): [T, (next: T | ((previous: T) => T)) => void];
	export function useEffect(
		effect: () => void | (() => void),
		dependencies?: readonly unknown[]
	): void;
	export function useMemo<T>(factory: () => T, dependencies: readonly unknown[]): T;
	export function useRef<T>(value: T): { current: T };
}
