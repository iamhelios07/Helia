# AI execution

AI execution reuses application API connections and player-selected models. Provider requests and credential access stay in the trusted Node.js or Tauri host. Creator scripts and UI receive neither credentials nor a model client. No additional package is required.

## Provider contracts

| API format                     | Generation endpoint                                         | Authentication                    |
| ------------------------------ | ----------------------------------------------------------- | --------------------------------- |
| OpenAI compatible              | `/chat/completions`                                         | Host-held bearer token            |
| OpenAI Responses               | `/responses`                                                | Host-held bearer token            |
| Anthropic                      | `/messages`                                                 | Host-held API key                 |
| Google                         | `/models/{model}:streamGenerateContent`                     | Host-held API key                 |
| Google Interactions            | `/interactions`                                             | Host-held API key                 |
| Existing Vertex AI connections | Google generation under the configured project and location | Host-issued service-account token |

Responses and Interactions use stateless requests (`store: false`). Native continuation data, including Google thought signatures, Anthropic signed thinking and OpenAI-compatible reasoning text, stays within the current loop. Responses request encrypted reasoning continuation data. Provider-supplied thinking is shown without an additional summarization call. Assistant text preceding tool calls is shown separately as intermediate progress, not labeled Thinking.

The adapters receive streaming responses and accept complete JSON responses. The agent buffers text and thinking during each model round: completed tool turns appear as intermediate progress, and the validated final answer is emitted once in full. Tool execution status and cancellation remain available during generation. Missing completion markers, partial streams, token-limited completions and provider errors prevent commits. Tool calling uses native provider APIs only. A read-only CBS subset assembles authored prompt content; structured-text/JSON tool-call fallback is excluded.

OpenAI-compatible requests use `max_tokens`; Responses use `max_output_tokens`. The model must support the chosen API contract and native tool calling when tools are exposed. Unsupported combinations fail explicitly rather than silently selecting a different model or format.

## Queries and tools

```javascript
const noArgs = { type: 'object', properties: {}, additionalProperties: false };

helia.defineQuery({
	name: 'getGold',
	description: 'Read the current gold balance.',
	arguments: noArgs,
	ai: true,
	run({ state }) {
		return state.gold;
	}
});

helia.defineAction({
	name: 'spendGold',
	description: 'Spend one gold.',
	arguments: noArgs,
	ai: true,
	run({ state }) {
		state.gold -= 1;
		helia.emit('goldSpent', {});
		return state;
	}
});
```

Only registrations with `ai: true` become model tools. Exposed names use the common provider identifier subset: a letter or underscore followed by letters, digits, underscores or hyphens, up to 64 characters. Arguments are validated before execution; invalid or unexposed calls fail the loop. Registration names starting with `$helia.` are reserved for host operations.

A Query receives deeply read-only state and arguments and returns a finite JSON value. It cannot change Game State, create Transactions, emit UI Events or request AI. It shares the existing QuickJS sandbox and limits. Actions still propose complete next state through Schema, Filter and included-Hook validation.

## Atomic execution

The trusted application entry point is `invokeSessionAI(gameId, sessionId, { text, visible, modelId }, options)`. `visible` defaults to true. `modelId` selects a player-owned model entry and defaults to the player's default model. Options provide an AbortSignal and a progress callback.

An invocation reads a consistent timeline and acquires a host lease. All tools operate on a detached workspace: later tools see earlier successful temporary changes, while UI subscriptions continue to see committed state. UI events remain buffered, and independent Hooks cannot commit until the root AI operation succeeds.

After final-answer completion, aggregate Filters, revision, content snapshot and cancellation are checked. One short host storage transaction writes the visible user message, if requested, the assistant message and net game-state changes. The user message has a history event without state changes; the assistant event owns all tool state changes. Intermediate tool calls never become branch points. Failure before commit preserves neither message nor partial changes, so retrying the retained composer draft does not duplicate input.

Both hosts reject conflicting state writes, history checkout/deletion and session deletion during generation. Expired or released leases cannot authorize delayed commits. Presentation-only changes remain available. Cancellation releases the lease and interrupts host streaming; a commit already underway may finish before cancellation is processed.

After the root commit, buffered UI events are delivered and independent Hooks may commit separately. Follow-up failures and timeline-refresh failures do not report the committed root as failed. Loop-generated requests cannot recursively start another loop while the session is busy.

Limits: 12 model rounds, 32 tool calls, two retries before provider output is received, 4 MiB request bodies and 2 MiB provider responses. There is no total generation deadline. Each model round times out after ten minutes without a response, including the wait for its first response. Actual provider bytes renew this deadline, including thinking, tool-call arguments and SSE comments, even when no visible text is produced. Activity frames forward those receipts across the trusted host boundary; they are not synthetic keepalives. Generation leases renew on the same activity. An inactivity timeout aborts the round without retrying or committing partial state. The next round after tools starts a new inactivity window. The web host uses a dedicated HTTP dispatcher so Node fetch's shorter default header/body deadlines do not override this policy; desktop applies the deadline to each blocking HTTP read. Existing creator-runtime limits also apply. Progress events reveal tool names and status rather than sensitive result values. Provider error bodies are hidden, and reflected credentials are redacted across response chunk boundaries.

## Explicit creator invocation

Game UI can explicitly invoke AI through its bridge:

```javascript
import { ai } from '@helia/ui';

await ai('Describe what happens after opening the door.', { visible: false });
```

UI invocation defaults to an internal event; `visible: true` creates a player message. It uses the player's default model. Generic UI actions do not automatically invoke AI.

For messages that do not need generation, use `appendMessage({ role: 'user' | 'assistant', content })` from `@helia/ui`, or `helia.appendMessage` inside Actions/Hooks. These are normal persisted chat messages, included in later conversation context. Script messages are staged with state changes and discarded if their enclosing operation fails. See [Adding chat messages](../ui/README.md#adding-chat-messages).

Synchronous creator Actions and Hooks can schedule a follow-up:

```javascript
helia.requestAI('Describe the result of this action.', { visible: true });
```

The repository starts this request only after the originating transaction commits, including games without custom UI. Failed operations discard it; Queries cannot request it. The UI bridge aborts its own pending invocation when disposed, and chat aborts its own request when unmounted. Shared activity and AI events let visible chat present requests made by custom UI or scripts.

## Prompt configuration

**Settings → Prompts** manages player-owned presets across all games. Presets are stored separately under `helia:prompt-settings` in the device/browser profile, never in game definitions, content snapshots or history. The selected preset is loaded once at invocation start, so existing sessions use saved changes on their next request while an in-flight loop retains a consistent configuration.

`parsePromptConfig` builds canonical preset configuration. `importPromptPreset` accepts the decoded prompt portion of a Risu preset, rebuilding supported fields without importing credentials or game-owned lorebook content. The settings file importer decodes JSON and Risu `.risupreset`/`.risup` containers before calling these validators. The settings UI supports named presets, creation, duplication, deletion, selection, file import, JSON export, ordered block editing and generation options, with explicit saves and unsaved-change protection.

`updateGameRules` accepts optional game-owned `ai` content containing only a version and lorebook. `parseGameAIContent` rebuilds those fields and drops legacy embedded preset fields when game content is read or saved; they are never selected as runtime presets. Existing serialized records are not rewritten merely by reading them. No arbitrary game preset is automatically promoted into the player's global settings. Game settings, lorebook and creator scripts retain their content-snapshot boundary until the later Apply stage.

| Feature               | Supported behavior                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Ordering              | Array order and per-block `enabled`                                                                                           |
| Plain types           | `plain`, `jailbreak`, `cot`, with separate jailbreak and CoT toggles                                                          |
| Special types         | `type2`: `normal`, `main`, `globalNote`                                                                                       |
| Content blocks        | `persona`, `description`, `lorebook`, `memory`, `authornote`, `postEverything`                                                |
| Roles                 | One `role` per block: `system`, `user`, `bot`; imported `assistant` normalizes to `bot`; cache also accepts `all`             |
| Formatting            | CBS-enabled `innerFormat` with literal `{{slot}}` data insertion; author-note `defaultText`                                   |
| History               | `chat` start/end slicing, negative indexes and `end`                                                                          |
| Chat role conversion  | `sendChatAsSystem` and per-block `chatAsOriginalOnSystem`                                                                     |
| ChatML                | Explicit system/user/assistant/bot blocks                                                                                     |
| Cache points          | Prior messages selected by role and depth; Anthropic ephemeral cache controls; no explicit caching request for other adapters |
| Trailing instructions | `postEverything` and `promptSettings.postEndInnerFormat`                                                                      |
| Assistant prefix      | `promptSettings.assistantPrefill`, when supported by the chosen model                                                         |
| Lorebook              | Enabled, always-on or keyword-matched entries; optional case sensitivity                                                      |
| Limits                | `maxTokens` and `maxContextChars`; oversized context fails without silently dropping history                                  |

All authored bodies belong to individual blocks. `plain`, `jailbreak` and `cot` use their own `text`, including blocks marked with the `main` or `globalNote` special type. `persona` and `postEverything` also use their own `text` and support `innerFormat`. There is no separate Common Content editor or shared body field. Lorebook entries belong to game AI content; description, opening and author's note reuse game settings. Preset blocks select where to place this game content. Context includes committed transaction information and branch-valid memories, with the current-state summary last. During tool execution this summary reflects accumulated temporary state. HypaV3 generation remains a separate stage.

Canonical prompt configuration is version 2; the containing prompt-settings document and exported preset envelope remain version 1. Loading a version-1 configuration or importing legacy Risu JSON copies nonempty `mainPrompt`, `globalNote`, `persona` and `postEverything` values into every corresponding block, preserving their previous precedence, roles, formatting, ordering and enabled flags. Text without a corresponding block is preserved in an appended disabled block, so it does not add new instructions. If preserving that text would exceed the 128-block limit, conversion fails without overwriting stored data. Reading settings does not rewrite storage; an explicit save or export writes only version-2 block bodies, and loading that output does not reapply legacy overrides.

Helia stores and executes a single `role` field. Its settings editor exposes one role selector, with no manual role for `chat` or `chatML`, whose roles come from their messages. At the input boundary, legacy Helia configurations normalize their former effective `role2 ?? role` into `role` and discard `role2`; cache blocks set to `all` retain their original all-role selection. A raw Risu import reads `role` for plain/jailbreak/CoT/cache blocks and `role2` for typed content blocks; stale fields from other block kinds are ignored. A Helia export envelope parses its `config` as Helia data, so a typed block's canonical `role` survives export and reimport. Explicitly versioned Helia configuration objects are also recognized by the import helper. Runtime assembly never reads `role2`.

A read-only [CBS subset](./cbs/README.md) evaluates authored instructions, selected persona descriptions, active lorebook content, block formatting and assistant prefills. Chat display and request copies expand CBS after their respective regex stage, while composer inputs and stored message source retain the syntax. Memories, native tool-turn transcripts, tool results and authoritative state summaries remain literal data. Game and resolved persona metadata are captured for the invocation; CBS state reads are re-evaluated against accumulated temporary state before every model round. Block order, roles, cache points and context limits still apply. Risu scripts and every sampling option are not implemented. Block `name` is authoring metadata. Public game metadata remains separate from AI instructions; `{{game}}` exposes the game title as text.

Reference contracts: [Risu prompt types](https://github.com/kwaroran/RisuAI/blob/main/src/ts/process/prompt.ts), [Risu prompt assembly](https://github.com/kwaroran/RisuAI/blob/main/src/ts/process/index.svelte.ts), [OpenAI streaming](https://developers.openai.com/api/docs/guides/streaming-responses), [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling), [Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [Google function declarations](https://googleapis.github.io/js-genai/release_docs/interfaces/types.FunctionDeclaration.html), [Google Interactions](https://ai.google.dev/api/interactions-api).

## Verification

Server tests use real SQLite and QuickJS with mock model turns and HTTP responses. Native tests cover IPC authorization, generation leases and a local HTTP stream with reflected test credentials, without real service keys. Browser tests cover composer streaming, cancellation, model selection, progress separation and explicit UI invocation. Actual execution results and environmental limits are recorded in the implementation plan.
