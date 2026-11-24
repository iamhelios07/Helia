/* Authoring declarations, loaded as .helia/runtime.d.ts inside each game project. */
type GameState = import('./GameState').GameState;
type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };
type ReadonlyJsonValue =
	null | boolean | number | string | readonly ReadonlyJsonValue[] | ReadonlyJsonObject;
interface ReadonlyJsonObject {
	readonly [key: string]: ReadonlyJsonValue;
}
type ReadonlyState<T> = [JsonValue] extends [T]
	? ReadonlyJsonValue
	: T extends object
		? { readonly [K in keyof T]: ReadonlyState<T[K]> }
		: T;

interface GameAction {
	name: string;
	args: JsonObject;
}
interface ChatMessageInput {
	role: 'user' | 'assistant';
	content: string;
}
interface CommitResult {
	revision: number;
}
interface TurnOptions {
	visible?: boolean;
}
type ModelContent =
	| { type: 'text'; text: string }
	| { type: 'image' | 'audio' | 'video' | 'file'; mimeType: string; data: string };
interface ModelToolCall {
	id: string;
	name: string;
	arguments: JsonValue;
}
interface ModelContinuation {
	provider:
		| 'openai-compatible'
		| 'openai-responses'
		| 'anthropic'
		| 'google'
		| 'google-vertex'
		| 'google-interactions';
	model: string;
	data: JsonValue[];
}
interface ModelMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | ModelContent[];
	toolCalls?: ModelToolCall[];
	toolCallId?: string;
	continuation?: ModelContinuation;
}
interface ModelTool {
	name: string;
	description?: string;
	arguments: ArgumentSchema;
}
interface ModelCallOptions {
	model?: 'main' | 'auxiliary';
	messages: ModelMessage[];
	tools?: ModelTool[];
}
interface ModelResponse {
	content: ModelContent[];
	toolCalls: ModelToolCall[];
	continuation?: ModelContinuation;
	usage?: { inputTokens: number; outputTokens: number };
}
interface ActionContext<TArgs extends object> {
	state: GameState;
	args: ReadonlyState<TArgs>;
}
interface ReadContext<TArgs extends object> {
	state: ReadonlyState<GameState>;
	args: ReadonlyState<TArgs>;
}

interface SchemaAnnotations {
	title?: string;
	description?: string;
	enum?: readonly JsonValue[];
}
type NullableType<T extends string> = T | readonly [T, 'null'] | readonly ['null', T];
type ValueSchema = SchemaAnnotations &
	(
		| { type: NullableType<'string' | 'number' | 'integer' | 'boolean'> | 'null' }
		| { type: NullableType<'array'>; items: ValueSchema }
		| {
				type: NullableType<'object'>;
				properties: Record<string, ValueSchema>;
				required?: readonly string[];
				additionalProperties: false;
		  }
	);
interface ArgumentSchema extends SchemaAnnotations {
	type: 'object';
	properties: Record<string, ValueSchema>;
	required?: readonly string[];
	additionalProperties: false;
}
interface OperationDefinition {
	name: string;
	description?: string;
	ai?: boolean;
}
interface ActionDefinition<TArgs extends object> extends OperationDefinition {
	arguments?: never;
	run(context: ActionContext<TArgs>): GameState | Promise<GameState>;
}
interface QueryDefinition<TArgs extends object> extends OperationDefinition {
	arguments?: never;
	run(context: ReadContext<TArgs>): JsonValue;
}
interface SchemaActionDefinition extends OperationDefinition {
	arguments: ArgumentSchema;
	run(context: ActionContext<JsonObject>): GameState | Promise<GameState>;
}
interface SchemaQueryDefinition extends OperationDefinition {
	arguments: ArgumentSchema;
	run(context: ReadContext<JsonObject>): JsonValue;
}
type StateSlot = { exists: false } | { exists: true; value: JsonValue };
interface StateChange {
	path: readonly string[];
	before: StateSlot;
	after: StateSlot;
}
interface RuleContext {
	readonly state: ReadonlyState<GameState>;
	readonly before: ReadonlyState<GameState>;
	readonly after: ReadonlyState<GameState>;
	readonly action: ReadonlyState<GameAction>;
	readonly changes: readonly ReadonlyState<StateChange>[];
}
interface FilterDecision {
	allow: boolean;
	reason?: string;
}
interface RuleDefinition {
	name: string;
	description?: string;
	priority?: number;
	actions?: readonly string[];
}
interface FilterDefinition extends RuleDefinition {
	run(context: RuleContext): FilterDecision;
}
interface HookDefinition extends RuleDefinition {
	mode?: 'included' | 'independent';
	run(context: RuleContext): readonly GameAction[] | void;
}

interface MigrationContext {
	readonly previous: ReadonlyState<JsonObject>;
	readonly migrated: ReadonlyState<GameState> | null;
	readonly previousSchema: ReadonlyState<ArgumentSchema>;
	readonly from: string;
}
interface MigrationDefinition {
	name: string;
	from?: string;
	description?: string;
	run(context: MigrationContext): GameState;
}

/** QuickJS logic API. Only Actions may await Web IO; state comes from each operation's context. */
interface HeliaRuntime {
	/** Scoped to this game. References can only be used in headers for their saved HTTPS URL. */
	readonly secrets: {
		has(name: string): Promise<boolean>;
		ref(name: string): Promise<string>;
	};
	/** Permission-gated HTTP(S), available during Action execution. */
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
	defineAction<TArgs extends object = JsonObject>(definition: ActionDefinition<TArgs>): void;
	defineAction(definition: SchemaActionDefinition): void;
	defineQuery<TArgs extends object = JsonObject>(definition: QueryDefinition<TArgs>): void;
	defineQuery(definition: SchemaQueryDefinition): void;
	defineFilter(definition: FilterDefinition): void;
	defineHook(definition: HookDefinition): void;
	defineMigration(definition: MigrationDefinition): void;
	emit(name: string, payload?: JsonObject): void;
	/** Buffer a message in the current Action or Hook's transaction. */
	appendMessage(message: ChatMessageInput): void;
	/** Schedule AI after the current Action or Hook commits. */
	queueTurn(text: string, options?: TurnOptions): void;
}

interface PanelDefinition {
	id: string;
	title: string;
	component: () => import('preact').ComponentChildren;
}
interface StoredFile {
	ref: string;
	name: string;
	mime: string;
	size: number;
	createdAt: string;
}
interface SessionFileStorage {
	save(blob: Blob, options?: { name?: string }): Promise<StoredFile>;
	read(ref: string): Promise<Blob>;
	stat(ref: string): Promise<StoredFile>;
	list(options?: {
		cursor?: string;
		limit?: number;
	}): Promise<{ files: StoredFile[]; nextCursor: string | null }>;
	remove(ref: string): Promise<void>;
}
interface ProgressProps {
	value: number;
	max?: number;
	label?: string;
}
interface ItemListProps<T> {
	items?: readonly T[];
	renderItem?: (item: T, index: number) => import('preact').ComponentChildren;
	label?: string;
}
interface StatsProps {
	items?: readonly { label: import('preact').ComponentChildren; value: JsonValue }[];
	label?: string;
}
/** Preact frame API. Writes resolve after the host commits. */
interface HeliaUIRuntime {
	readonly secrets: {
		set(name: string, value: string, options: { url: string }): Promise<void>;
		has(name: string): Promise<boolean>;
		remove(name: string): Promise<void>;
	};
	readonly storage: SessionFileStorage;
	useAssetURL(ref: string | null | undefined): {
		url: string | null;
		loading: boolean;
		error: Error | null;
	};
	asset(pathOrId: string): string;
	getState(): ReadonlyState<GameState>;
	subscribeState(listener: (state: ReadonlyState<GameState>) => void): () => void;
	useGameState(): ReadonlyState<GameState>;
	useUIState<T>(key: string, initial: T): [T, (next: T | ((previous: T) => T)) => void];
	useUIEvent(name: string, listener: (payload: ReadonlyState<JsonObject>) => void): void;
	onEvent(name: string, listener: (payload: ReadonlyState<JsonObject>) => void): () => void;
	onDispose(dispose: () => void): () => void;
	action(name: string, args?: JsonObject): Promise<CommitResult>;
	commitState(action: GameAction, nextState: GameState): Promise<CommitResult>;
	runTurn(text: string, options?: TurnOptions): Promise<CommitResult>;
	/** One model response, with no automatic context, tool execution or commit. */
	callModel(options: ModelCallOptions): Promise<ModelResponse>;
	appendMessage(message: ChatMessageInput): Promise<CommitResult>;
	registerPanel(panel: PanelDefinition): () => void;
	Button(props: import('preact').JSX.IntrinsicElements['button']): JSX.Element;
	Text(props: import('preact').JSX.IntrinsicElements['span']): JSX.Element;
	Progress(props: ProgressProps): JSX.Element;
	Inventory<T>(props: ItemListProps<T>): JSX.Element;
	Stats(props: StatsProps): JSX.Element;
	QuestList<T>(props: ItemListProps<T>): JSX.Element;
}

declare const helia: HeliaRuntime;
declare namespace JSX {
	type Element = import('preact').JSX.Element;
	type IntrinsicElements = import('preact').JSX.IntrinsicElements;
	type IntrinsicAttributes = import('preact').JSX.IntrinsicAttributes;
	type ElementChildrenAttribute = import('preact').JSX.ElementChildrenAttribute;
	type ElementAttributesProperty = import('preact').JSX.ElementAttributesProperty;
}

declare module '@helia/state' {
	export type GameState = import('./GameState').GameState;
}
declare module '@helia/ui' {
	export type ModelContent = globalThis.ModelContent;
	export type ModelToolCall = globalThis.ModelToolCall;
	export type ModelMessage = globalThis.ModelMessage;
	export type ModelTool = globalThis.ModelTool;
	export type ModelCallOptions = globalThis.ModelCallOptions;
	export type ModelResponse = globalThis.ModelResponse;
	export const callModel: HeliaUIRuntime['callModel'];
	export const storage: HeliaUIRuntime['storage'];
	export const secrets: HeliaUIRuntime['secrets'];
	export const useAssetURL: HeliaUIRuntime['useAssetURL'];
	export type ChatMessage = ChatMessageInput;
	export const helia: HeliaUIRuntime;
	export const useGameState: HeliaUIRuntime['useGameState'];
	export const getState: HeliaUIRuntime['getState'];
	export const useUIState: HeliaUIRuntime['useUIState'];
	export const useUIEvent: HeliaUIRuntime['useUIEvent'];
	export const onEvent: HeliaUIRuntime['onEvent'];
	export const onDispose: HeliaUIRuntime['onDispose'];
	export const registerPanel: HeliaUIRuntime['registerPanel'];
	export const subscribeState: HeliaUIRuntime['subscribeState'];
	export const action: HeliaUIRuntime['action'];
	export const commitState: HeliaUIRuntime['commitState'];
	export const runTurn: HeliaUIRuntime['runTurn'];
	export const appendMessage: HeliaUIRuntime['appendMessage'];
	export const asset: HeliaUIRuntime['asset'];
	export const Button: HeliaUIRuntime['Button'];
	export const Text: HeliaUIRuntime['Text'];
	export const Progress: HeliaUIRuntime['Progress'];
	export const Inventory: HeliaUIRuntime['Inventory'];
	export const Stats: HeliaUIRuntime['Stats'];
	export const QuestList: HeliaUIRuntime['QuestList'];
}
