# Scripting API

Helia's scripting API lets creators define game rules, interact with chat and AI, and build custom game panels in TypeScript. Scripts access the API through the global `helia` object.

Logic scripts run in QuickJS. Actions may be asynchronous; Queries, Filters, Hooks and registration stay synchronous. UI scripts run in an isolated Preact frame and can also import APIs from `@helia/ui`. Each scripting runtime exposes its own API subset.

The editor provides completion and types through the generated `.helia/runtime.d.ts`. See the [authoring declarations](../src/lib/games/authoring/runtime.d.ts), [game UI guide](../src/lib/games/ui/README.md) and [AI execution guide](../src/lib/games/ai/README.md) for implementation details.

## Logic scripts

Logic scripts register Actions, Queries, Filters and Hooks in `main.ts` or its imported modules. Registrations are recreated for each execution, so persistent data belongs in Game State.

| API                                      | Behavior                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `helia.defineAction<Args>(definition)`   | Register an operation that receives `{ state, args }` and returns the complete next state. State is mutable; arguments are read-only.             |
| `helia.defineQuery<Args>(definition)`    | Register a read-only operation that receives `{ state, args }` and returns a JSON value.                                                          |
| `helia.defineFilter(definition)`         | Validate a proposed state change. Return `{ allow: boolean, reason?: string }`. Rejection cancels the operation.                                  |
| `helia.defineHook(definition)`           | React to state changes by returning an array of Actions: `[{ name, args }]`. Returning nothing is equivalent to an empty array.                   |
| `helia.emit(name, payload?)`             | Buffer a UI event for delivery after a successful commit. Available inside Actions and Hooks. Payload defaults to `{}` and must be a JSON object. |
| `helia.appendMessage({ role, content })` | Buffer a chat message with the current Action or Hook. Returns synchronously; failure discards the message with the state changes.                |
| `helia.queueTurn(text, { visible }?)`    | Schedule an AI request after the Action or Hook commits. `visible` defaults to `false`.                                                           |
| `helia.fetch(input, init?)`              | Call an external HTTP(S) service inside an Action. Returns a Promise with a Fetch Response; global `fetch` is the same function.                  |

Actions and Queries accept these definition fields:

| Field          | Behavior                                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`         | Unique within the registration kind. Names beginning with `$helia.` are reserved.                                                                                               |
| `description?` | Describe the operation, including its purpose for AI tool use.                                                                                                                  |
| `arguments?`   | Explicit object JSON Schema. Alternatively, provide an `Args` type to generate validation and tool schemas. The two forms cannot be combined. Omitting both means no arguments. |
| `ai?`          | Expose the operation as an AI tool when `true`. Defaults to `false`.                                                                                                            |
| `run(context)` | An Action returns valid Game State or a Promise of it. A Query synchronously returns a finite JSON value.                                                                       |

Filters and Hooks accept `name`, `run`, optional `description`, `priority` and `actions`. Lower priorities run first; the default is `0`. Omit `actions` to match all action names, or provide a list to restrict matches.

Their read-only context contains `state`, `before`, `after`, `action` and `changes`. Filters inspect proposed state. Hooks enqueue Actions instead of mutating their context. Hooks also accept `mode`: `included` (default) shares the originating transaction; `independent` runs separately after it commits. Hooks run when state actually changes.

External work belongs in an Action. The UI only needs to call `action('loadReward')`; the same Action can be exposed as an AI tool.

```ts
helia.defineAction({
	name: 'loadReward',
	async run({ state }) {
		const response = await helia.fetch('https://api.example.com/reward');
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const reward = await response.json();
		if (!Number.isSafeInteger(reward.gold)) throw new Error('Invalid reward');
		state.gold += reward.gold;
		return state;
	}
});
```

State, messages and events remain provisional across `await`. Filters and included Hook Actions finish before committing. A rejection, cancellation, invalid result or revision conflict discards those provisional changes. A Hook may enqueue an asynchronous Action, but its own `run` stays synchronous. Fetch is forbidden during registration, Queries, Filters and Hooks. Await external work before returning; unfinished Web operations reject the Action. An external service's side effects cannot be rolled back by a rejected game transaction.

## Save migrations

Register a save migration with `helia.defineMigration` in a logic script. In legacy games this is one of the `scripts` entries. In a code project, put it in `main.ts` or a module reachable through its logic imports. A UI-only module or an unreferenced file does not register migrations. Migration source is part of released game content.

For example, after changing the state field `gold` to `coins`:

```ts
helia.defineMigration({
	name: 'gold-to-coins',
	from: '>=1.0.0 <2.0.0',
	description: 'Preserve saved currency after renaming gold.',
	run({ previous, migrated }) {
		if (!migrated || typeof previous.gold !== 'number') {
			throw new Error('Currency cannot be migrated');
		}
		return { ...migrated, coins: previous.gold };
	}
});
```

The deeply read-only context contains `previous` (the old saved JSON object), `previousSchema`, `from` (the selected release version), and `migrated` (the default migration result, or `null` if the default rules failed). Old fields are untyped JSON; narrow their types before using them. Return the complete new Game State synchronously. The result must satisfy the new schema; missing fields are not filled afterward. Promises, accessors, non-finite numbers and other non-JSON values are rejected.

`from` is optional. A range uses full SemVer versions prefixed by `<`, `<=`, `>`, `>=` or `=`, separated by spaces; every comparison must match. Prereleases follow SemVer precedence and build metadata is ignored. Partial versions, wildcards, `^`, `~` and `||` are unsupported. Set an upper bound such as `<2.0.0` so a migration retained in future releases does not accidentally apply to newer saves. No match uses default rules; multiple matches cancel the entire operation. Up to 16 migrations may be registered, with at most eight comparisons and 256 characters in each range.

Migrations run against initial state, every historical branch and current state with the same rule. Each distinct input runs in a fresh isolated context. The context exposes no session identity, network, credentials, messages or events. `Math.random`, `Date`, `WeakRef` and `FinalizationRegistry` are unavailable. Registration and execution together have the same per-input CPU and memory ceilings as Actions. Cancellation or any migration failure aborts the operation without a partial save.

For a released game, structural Apply recalculates baseline-origin saves from the selected release baseline. Records created while playing a later draft receive only default rules. Repeated Apply therefore starts from the baseline again. Unreleased games use default rules. During normal play, declarations are validated but migrations are not invoked.

## UI scripts

UI scripts register Preact panels and connect player interactions to game logic. Start UI modules with `'use ui';`. The following APIs are available both on global `helia` and as named exports from `@helia/ui`.

### State and operations

| API                                      | Behavior                                                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `getState()`                             | Read the current deeply frozen, committed Game State.                                                                            |
| `subscribeState(listener)`               | Receive the current state immediately and subsequent updates. Returns an unsubscribe function.                                   |
| `useGameState()`                         | Subscribe from a Preact component with automatic cleanup.                                                                        |
| `action(name, args?)`                    | Run a registered Action through argument, state, Filter, Hook and revision checks. Arguments default to `{}`. Returns a Promise. |
| `commitState({ name, args }, nextState)` | Submit a complete state proposal through validation and Hooks. Does not execute the named Action's body. Returns a Promise.      |
| `useUIState(key, initialValue)`          | Share transient JSON UI state within a game/session. Returns `[value, setter]`; the setter accepts a value or updater function.  |

Game State participates in persistence and history. UI state stays in memory for the current app execution and does not participate in branches or saved game content.

### Chat and AI

| API                                | Behavior                                                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `appendMessage({ role, content })` | Persist a chat message without generation. Resolves to `{ revision }` after commit.                                                          |
| `runTurn(text, { visible }?)`      | Invoke the player's default AI model. Returns a Promise. `visible` defaults to `false`; `true` also records the request as a player message. |

Message roles are `user` or `assistant`, and content must be a nonblank string. Messages enter normal conversation context and history. Markdown and sanitized HTML are supported in chat display. Appending a message does not automatically request an AI reply.

`action`, `commitState`, `runTurn` and `appendMessage` resolve to `{ revision: number }` after commit. Await each write before starting another, and handle rejected requests. Conflicts, validation errors, cancellation or a busy session can reject an operation. AI tool changes commit together with the final answer; a failed generation discards temporary changes.

### Model calls

`runTurn` runs the full session turn with its selected prompt preset, conversation and game tools. Logic scripts use `queueTurn` to schedule that turn after a successful commit. `callModel` makes a single request using only the supplied messages and tools. It does not assemble a preset, render CBS, run chat regex, execute tools or save its response. It is available in the asynchronous UI runtime.

```ts
const response = await helia.callModel({
	model: 'auxiliary', // 'main' by default
	messages: [
		{ role: 'system', content: 'Evaluate the proposed equipment.' },
		{ role: 'user', content: idea }
	]
});
```

`model` selects the app's default model or its auxiliary binding in **Settings → Models**. An unset auxiliary model rejects the call. Generation settings belong to the selected model; `temperature` and token limits are not call arguments. A model's optional maximum output tokens overrides the preset limit for session turns; direct model calls use that limit or 4,096 tokens.

`messages` accepts `{ role, content, toolCalls?, toolCallId?, continuation? }`. Roles are `system`, `user`, `assistant` and `tool`. Content is a string or an array of `{ type: 'text', text }` and `{ type: 'image' | 'audio' | 'video' | 'file', mimeType, data }` blocks. Media data is base64. Media support depends on the configured provider and model; unsupported input formats reject instead of being dropped. Tool results use string content and the matching `toolCallId`.

`tools` optionally declares `{ name, description?, arguments }` with the same object JSON Schema profile as Action arguments. These are caller-owned functions, not automatic registrations of game Actions or Queries. The response is `{ content, toolCalls, continuation?, usage? }`. `content` is an array of content blocks; `toolCalls` contains `{ id, name, arguments }`. When available, `usage` contains `inputTokens` and `outputTokens`.

To continue after tool calls, append `{ role: 'assistant', ...response }`, followed by a `tool` message for each call, then call the model again. Preserve `continuation` unchanged; it holds provider continuation data and cannot be reused with another provider or model. The caller decides whether to execute any function or apply an Action.

Both calls collect the streamed response before resolving. Ten minutes without stream activity times out; closing the UI cancels its active request. Direct calls temporarily reserve the session's generation slot but do not advance its revision. UI messages remain subject to the existing 2 MiB bridge limit.

### Panels, events and assets

| API                                       | Behavior                                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `registerPanel({ id, title, component })` | Register a Preact function component as a game panel. Returns an unregister function.                             |
| `onEvent(name, listener)`                 | Observe committed UI event payloads. Returns an unsubscribe function. History restoration does not replay events. |
| `useUIEvent(name, listener)`              | Subscribe to an event from a Preact component with automatic cleanup.                                             |
| `onDispose(callback)`                     | Register runtime cleanup. Returns a function that removes the callback.                                           |
| `asset(pathOrId)`                         | Resolve a packaged asset path or stable resource ID to a data URI. Throws if the asset is missing.                |

Use `useUIState` for presentation state such as selected tabs. Store game progress in Game State. `asset()` reads resources registered by the creator; it does not create or save files.

### Components

| Component   | Props                                                     |
| ----------- | --------------------------------------------------------- |
| `Button`    | `children` and button props. Defaults to `type="button"`. |
| `Text`      | `children` and span props.                                |
| `Progress`  | `value`, `max` (default `100`), `label`.                  |
| `Inventory` | `items`, `renderItem(item, index)`, `label`.              |
| `Stats`     | `items: { label, value }[]`, `label`.                     |
| `QuestList` | `items`, `renderItem(item, index)`, `label`.              |

These are presentation helpers; they do not define inventory rules, statistics or quest progression. Ordinary Preact elements are also available. Packaged imports support `preact`, `preact/hooks`, `@helia/ui` and relative project modules. Import the generated state type with `import type { GameState } from '@helia/state'`.

### Game secrets

Game secrets are private player configuration shared by every session of the current game. They are separate from Game State, messages, branches and exported game content. The current Helia profile owns the store. Model API keys and service accounts live in a separate credential domain and are never accessible through these methods. Creators cannot choose a credential ID, storage path, user or game scope; the host supplies the current game.

| Context     | API                                 | Behavior                                                                     |
| ----------- | ----------------------------------- | ---------------------------------------------------------------------------- |
| UI          | `secrets.set(name, value, { url })` | Register or replace a secret for an exact HTTPS destination.                 |
| UI / Action | `secrets.has(name)`                 | Check whether this game has the named secret.                                |
| UI          | `secrets.remove(name)`              | Delete the current game's secret.                                            |
| Action      | `helia.secrets.ref(name)`           | Get an opaque reference for use in request headers. Never returns the value. |

UI imports `secrets` from `@helia/ui` or uses `helia.secrets`. Logic uses `helia.secrets` inside Actions. All methods return Promises. There is no plaintext `get`, enumeration, encryption or decryption interface. Names contain 1–64 letters, digits, dots, underscores or hyphens and start with a letter. Registration and deletion are immediate private operations; they do not create a game transaction and are not undone by branch checkout.

```ts
// UI event handler: keep the input out of state, Action arguments and chat.
await secrets.set('novelai', tokenInput, {
	url: 'https://image.novelai.net/ai/generate-image'
});

// Action: the host substitutes the value only for the saved HTTPS URL.
const reference = await helia.secrets.ref('novelai');
const response = await helia.fetch('https://image.novelai.net/ai/generate-image', {
	method: 'POST',
	headers: { authorization: `Bearer ${reference}` },
	body: JSON.stringify(payload)
});
```

References are bound to the game, name, value and exact destination, including query parameters. They cannot authorize another game's request or a redirect to another URL. Changed values/destinations invalidate old references. Use references only in headers; do not store them in state or chat. Reflected credential bytes in response headers or bodies cause the request to fail. Network consent and private-address restrictions still apply.

The web host uses its own encrypted database and key; desktop uses its own OS credential service. Neither exposes provider credentials. Secrets remain outside export/import and must be registered by each player. Editor previews have no persistent secret access (`has` returns false); normal play shares values across sessions and reloads. Failures report `Game secret unavailable` without including input values.

### Session file storage

`storage` is available as `helia.storage` and as an export from `@helia/ui`. It stores immutable files for the current session, separately from Game State, chat history and packaged assets.

| API                                | Behavior                                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage.save(blob, { name }?)`    | Save a Blob and return `{ ref, name, mime, size, createdAt }`. Names are display labels; duplicates are allowed.                                          |
| `storage.read(ref)`                | Read a file as a Blob.                                                                                                                                    |
| `storage.stat(ref)`                | Read metadata without loading file bytes.                                                                                                                 |
| `storage.list({ cursor, limit }?)` | Return `{ files, nextCursor }`, ordered by reference. The default page size is 50; the maximum is 100.                                                    |
| `storage.remove(ref)`              | Permanently delete a file, including files referenced by state or history.                                                                                |
| `useAssetURL(ref)`                 | Resolve supported media to `{ url, loading, error }`. Releases temporary URLs on changes and unmount. Accepts null or undefined when no file is selected. |

All storage operations return Promises. Save the returned `helia-file:...` reference in Game State through an Action. Use `useAssetURL` for UI media, or include the reference in a Markdown image or HTML media `src` in chat. Chat resolves references inside images, audio, video and source elements; CSS URLs and arbitrary file execution are not supported. Missing or deleted media displays a placeholder without changing saved message source. File contents are not automatically included in AI context.

Files survive reloads, branch checkout and history deletion. There is no automatic cleanup, expiry or reference-based deletion. Deleting a session or permanently deleting its game deletes its files. Trash preserves files. Explicit file deletion applies across all branches in the session and is not undone by history restoration. Other sessions cannot access the file even if they know its reference.

Limits are 8 MiB per file, 128 MiB and 2,048 files per session. Exceeding a limit fails the write and preserves existing files. Saves and subsequent Actions are independent operations; a failed Action leaves an already saved file intact. Errors use `FILE_INPUT`, `FILE_NOT_FOUND`, `FILE_QUOTA` or `FILE_UNAVAILABLE`. Editor previews and test play use isolated in-memory stores.

```ts
import { storage, action } from '@helia/ui';

const file = await storage.save(imageBlob, { name: 'sword.webp' });
await action('setEquipmentImage', { image: file.ref });
```

Use asynchronous storage calls inside a UI event handler or effect; top-level `await` is unavailable. File storage remains a UI API; logic receives file references through arguments.

### HTTP requests

Actions call `helia.fetch(input, init?)` or global `fetch`; the aliases are identical. The Web Fetch signature accepts an absolute HTTP(S) URL, `URL` or `Request` and returns a Promise of a Response. Logic uses isolated Web facades backed by the trusted Worker. UI has no Fetch API or network bridge; it invokes Actions instead.

```ts
// Inside an Action's async run().
const response = await helia.fetch('https://api.example.com/images', {
	method: 'POST',
	headers: {
		'content-type': 'application/json',
		authorization: `Bearer ${serviceKey}`
	},
	body: JSON.stringify({ prompt }),
	signal: abortController.signal
});
if (!response.ok) throw new Error(`HTTP ${response.status}`);
const image = await response.blob();
// Process the transient Blob here; it cannot be stored directly in Game State.
```

Helia asks the player before connecting to a new **origin** (scheme, domain and port). Consent lasts for the current Action transaction, including included Hook Actions, and does not enter game data or history. Concurrent requests share the confirmation. Cancelling all requests waiting for it closes the dialog. A redirect to another origin requires its own permission and strips `Authorization` before proceeding.

The host sends requests through the web server or private desktop bridge, so destination CORS rules do not apply. It never attaches Helia cookies or stored model-provider credentials. Scripts must supply their own service authorization; avoid storing secrets in shared source or Game State. Cookie headers, `Set-Cookie`, browser credential forwarding and privileged transport headers are unavailable. Public network addresses are supported; loopback, private networks, link-local/cloud metadata and special address ranges are blocked, including after DNS resolution. Redirect destinations are checked again, and resolved addresses are pinned for each connection.

JSON, text, `Blob`, `ArrayBuffer`, `URLSearchParams` and `FormData` request bodies use normal `Request` serialization. Uploads are buffered up to **8 MiB**. Responses stream after headers, up to **32 MiB**, with `text()`, `json()`, `blob()`, `arrayBuffer()`, `body`, `clone()`, `url` and `redirected`. HTTP error statuses resolve normally; permission, network and limit failures reject or error the body stream. `AbortSignal` cancels uploads, pending consent and response reads. Cancelling an Action or closing its UI cancels its requests. Each logic execution permits 16 concurrent requests and ten minutes of network inactivity.

Logic also provides `Headers`, `Request`, `Response`, `Blob`, `File`, `FormData`, `URL`, `URLSearchParams`, `AbortController`, `AbortSignal`, `TextEncoder` and `TextDecoder`. Response streams support ordinary readers, cancellation, teeing and asynchronous iteration. Browser callback APIs, custom stream construction and BYOB readers are unavailable. Web objects remain transient and cannot enter JSON Game State. Materializing text or byte buffers still obeys QuickJS's 16 MiB memory limit; stream large bodies or retain Blob handles. Web RPC is bounded to 512 objects, 4,096 operations and 64 MiB of retained Blob data per execution. Native body constructors enforce size limits before allocating. The 500 ms CPU budget counts interpreter work, including resumed continuations, but excludes host IO waits.

This is a host Fetch bridge, not a browser cookie/cache context. `credentials: 'include'`, `mode: 'no-cors' | 'same-origin'`, integrity checks and `keepalive` reject explicitly. Browser referrer, cache and priority hints are not forwarded. Redirect defaults to `follow`; `error` rejects redirects, and `manual` returns the HTTP redirect response.

## Runtime boundaries

Logic scripts receive state through their execution context. UI scripts read committed state and request changes through the host bridge. Authoring types distinguish the two scripting runtimes. The editor resolves global `helia` for each module, including inherited UI helpers; modules shared by both runtimes can only use their common APIs.

The scripting API does not expose stored API credentials, a provider client or the host filesystem. UI frames have no Fetch API or host network bridge and keep direct network access blocked by CSP. Logic runs in QuickJS and receives only bounded Web RPC callbacks, never host object references. Its HTTP requests pass through the permission-gated host bridge. External packages, dynamic imports and top-level `await` are unavailable.
