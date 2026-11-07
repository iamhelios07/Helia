# SQLite storage

Helia uses **Drizzle + SQLite** for its single-user web and desktop applications. The database starts empty. There is no IndexedDB import, fallback, dual write or old-record conversion.

Until implementation stage 10, internal storage changes do not require data migrations. Update the initial schema and current record formats, and develop and test against a fresh database. Do not add incremental migrations or compatibility paths to preserve earlier development data. This policy concerns Helia's internal storage format; creator-defined game-state schema changes are a separate product feature. Decide the internal compatibility policy for stage 10 onward at that stage.

## Locations and startup

- Web: `data/helia.sqlite`, relative to the server working directory. Set `HELIA_DATA_DIR` to an absolute directory to choose a persistent location.
- Desktop: `helia.sqlite` inside Tauri's application data directory for `com.helia.desktop`.
- Web and desktop databases are independent; there is no automatic synchronization.

For local development, use `pnpm dev:web`. For a built web server over plain HTTP, set its public origin explicitly:

```powershell
pnpm build:web
$env:HELIA_ORIGIN = 'http://localhost:3000'
pnpm start
```

When deployed behind a reverse proxy, `HELIA_ORIGIN` is the public origin visible to the browser, including the scheme and nonstandard port. This is checked on storage POST requests. The server remains a single-user application; no account system was added.

Desktop development uses `pnpm desktop:dev`. A browser preview of the desktop build cannot access the native database.

## API credential storage policy

The application settings use separate trusted-host credential storage and model-list requests. Credentials are independent of game storage and exports. [AI execution](../games/ai/README.md) reuses these credentials for host-mediated generation and enforces per-session generation leases on state writes.

- **Tauri:** keep API keys in the operating system's credential store, accessed by the trusted native host. SQLite may hold non-secret provider settings and credential references, but not the API keys themselves.
- **Node.js:** encrypt API keys before storing them in SQLite. On first use, automatically generate a cryptographically random master key and retain it in a separate file restricted to the server's operating-system account. Reuse it after restarts; external secret-manager setup and a user-entered master password are not required.
- Master-key creation must be safe under concurrent startup. A missing, unreadable or invalid key for existing encrypted credentials must produce an explicit error without silently generating a replacement or destroying the stored ciphertext. Recovery requires restoring the correct key or explicitly replacing the affected API credentials.
- Keep secret access and provider requests inside the trusted host. Do not return stored API keys or the master key to creator code or include them in game state, snapshots, logs, diagnostics, game packages or play-data exports. Do not silently fall back to plaintext storage when the selected store is unavailable.

The [Node.js credential host](../server/credentials.ts) uses AES-256-GCM with fresh nonces and the connection ID as authenticated data. Its separate database is `credentials.sqlite` under `HELIA_DATA_DIR` (default `data`), and its 32-byte master key is `secrets/master.key` under the same directory. The private directory is created before the key, with POSIX permissions `0700`/`0600` or a Windows ACL restricted to the current OS account. The key is published atomically without overwriting an existing file. Existing ciphertext is validated before replacement. Losing the master key requires restoring the correct key or explicitly deleting all affected credentials and entering them again. Persistent installations must retain both files across restarts; a database backup alone cannot restore credentials.

The [Tauri credential host](../../../src-tauri/src/credentials.rs) uses the `keyring` crate with Windows Credential Manager, macOS Keychain or Linux Secret Service. The service name is `com.helia.desktop.api`; each connection ID identifies an entry. An unavailable or locked OS store returns an error. The native command requires the existing main-frame-only per-process token, and no general credential-reading API is exposed to game frames.

Service-account JSON follows the same secret-storage policy as API keys. Only project ID, region and the generated Vertex endpoint belong to ordinary settings metadata. The [native credential record store](../../../src-tauri/src/credential_store.rs) splits secret records into binary entries of at most 2,000 bytes to accommodate Windows credential limits. A small manifest records a random generation, chunk count, length and SHA-256 digest. New chunks are written before publishing the manifest; a failed write preserves the active generation. Successful replacement and deletion remove the previous generation's entries. A process crash during a write can leave unreachable chunks in the OS store, but no plaintext file fallback is used.

Service-account RSA keys are independently validated on each host. OAuth JWT grants are signed inside the host and sent only to the fixed Google token endpoint. Access tokens remain in a bounded in-memory cache, are renewed before expiry and are invalidated on credential writes or deletion. No access token is persisted in SQLite, OS credential entries or browser storage. Authentication verification returns only a boolean result. It does not validate Vertex IAM roles, model access or generation permissions.

Both hosts bind a stored key to the saved connection ID, URL and API format. Model listing rejects a changed endpoint until its key is explicitly saved. The web endpoint checks the request origin and accepts JSON only; it follows the same single-user hosting model as game storage. See [settings behavior](../app/settings/README.md) for connection management and model discovery.

Node.js encryption protects a copied database when the master-key file is not copied with it. Possession of both the database and key file permits decryption; the separate file is not an independent OS credential store.

## Responsibilities

- [Schema](./schema.ts): fixed application tables, ownership constraints and indexes. Game-specific state remains validated JSON.
- [Initial migration](./migrations/0000_initial.sql): generated by Drizzle Kit and included in both hosts. The initial schema is marked with SQLite `user_version = 1`; unsupported versions fail explicitly.
- [Protocol](./protocol.ts): bounded storage operations and runtime validation; no SQL strings or file paths are accepted from callers.
- [Working set](./unit.ts): detached game/session records, changed-record detection and bounded retries for optimistic storage conflicts.
- [Shared repository](../games/repository-core.ts): game/session/chat/history operations. The UI keeps the existing repository interface.
- [Web host](../server/sqlite.ts): Drizzle with better-sqlite3, accessed through the same-origin storage endpoint.
- [Desktop host](../../../src-tauri/src/storage.rs): rusqlite, executed through one Tauri command per atomic operation.

Game metadata and sessions are scoped by game ID. Opening a session additionally loads that session's messages, snapshots, progress, transactions and memories. Only changed records are written. Session deletion cascades to its owned records.

## Atomicity and concurrency

Each game has an internal storage version, separate from its content version and session progress revision. The shared repository reads a consistent working set, calculates changes outside SQL, then asks the host to commit them only if that storage version still matches.

The host opens one short transaction, advances the version, writes all records and verifies the active session. Every write rolls back on failure, including the version update. Normal operations retry storage conflicts up to eight times. Explicit game-state commits still check the requested session revision, so a stale AI result cannot overwrite a newer branch or state.

Snapshots, transaction results and memories are insert-only during normal commits. The bounded `prune` operation deletes a selected event subtree atomically, checking the expected session revision inside the host transaction. It removes linked messages and memories depending on removed events, compacts surviving message sequence numbers while preserving message IDs, restores progress, and advances both the session revision and game storage version. A stale request or any failure rolls back the entire operation. Session records and message sequence positions can be updated. SQLite foreign keys and composite ownership constraints prevent records from referring to another session's snapshot. WAL and a five-second busy timeout are enabled; committed data uses `synchronous = FULL`.

Database transactions do not stay open across UI, AI or script work. Creator code receives no database connection or raw SQL executor.

## Current runtime behavior

The [runtime model](../games/state/model.ts) and [state engine](../games/state/engine.ts) define serializable records and pure state/branch operations. Use the [game repository](../games/repository.ts) for application writes. A game owns creator content; a session is an independent playthrough. Actions carry a creator-defined name and JSON arguments, independent of whether UI, AI or scripts initiate them.

The first session access creates a `GameSnapshot` containing game rules and content. Existing sessions retain that copy until the later Apply/version stage. This is different from the periodic game-state checkpoints proposed in the product specification.

The engine accepts finite JSON data and rejects cycles, class instances, accessors, sparse arrays and prototype-related keys. Arrays are recorded as complete values; object paths use string arrays. State, transaction, optional message and activity metadata commit together.

Games and game-content snapshots require a `schema` beside `initialState`. The [state schema validator](../games/state/schema.ts) implements the subset defined in the [product specification](../../../docs/SPEC.md): closed typed objects, homogeneous arrays, primitive types, nullable types, required fields, enums and title/description annotations. Objects explicitly declare `additionalProperties: false`. Validation never coerces values or inserts defaults. Existing development records without this schema are not converted.

Initial state is validated when parsing game rules and snapshots. Loaded state and restored transaction outcomes are validated against the session's content snapshot. Both storage hosts validate the resulting progress and all recorded branch outcomes inside each affected session's write transaction; a schema failure or mismatch with history rolls back metadata, messages, state and the storage version together.

The [transaction workspace](../games/state/workspace.ts) accumulates detached changes without keeping a database transaction open. `step` validates declared argument schemas before running a synchronous host operation, then validates its proposed state. `replace` validates a complete state proposal. `finish` returns the net state and change set; failed or aborted workspaces cannot finish. The repository still checks the session revision and revalidates final state at commit time.

`generateStateTypes` produces a standalone `GameState` TypeScript declaration with optional fields, nullable values, arrays and literal enums. It does not replace runtime validation. The trusted synchronous `TransactionValidator` seam receives frozen detached before/after state, changes and action information and can reject finalization. Sandboxed creator Filters and Hooks run through the creator runtime below before this final host validation and SQL commit.

Branch selection restores recorded results without rerunning AI, scripts or randomness. New transactions from an earlier parent preserve existing continuations. `getSessionTimeline` returns every branch as depth-first events, the selected path's conversation, current state and valid memories. Each transaction, including its optional message, is one navigation and deletion unit. Message-only and state-only transactions are supported. Authored opening content belongs to the selectable initial state. Creator descriptions take priority over rule-based summaries, with no model call needed.

`deleteSessionEvent` removes an event and every descendant, preserving shared predecessors and other futures. If the selected head is removed, the subtree root's parent becomes selected; without a parent, progress restores the initial state. Deleting an inactive branch preserves the selected head and state but advances the revision to reject pending work based on the old history. `deleteSessionResponse` performs the same deletion after checking that the event contains an assistant dialogue. The history panel separates navigation from deletion and requires a confirmation modal for deletion.

State restoration replays recorded changes from the content snapshot's initial state. Explicit authoring Apply creates new content snapshots with validated migration checkpoints for existing event IDs, so historical branches use the new schema without rewriting their original transaction records. New transactions replay normally after those checkpoints. Both hosts validate every branch in the atomic write. Host-controlled history deletion also purges deleted event checkpoints from all owned snapshots. This does not introduce periodic runtime checkpoints or garbage collection.

Conversation reads return the active path and authored opening; `messageCount` includes all surviving branches' messages. Normal sends record a `sendMessage` action. Both hosts check message counts, contiguous sequence numbers, unique event-message links and memory source existence along with recorded state. Memories are visible only when all source transaction IDs belong to the active path. HypaV3 generation and retrieval are later integrations.

## Creator runtime

The [creator runtime](../games/scripting/engine.ts) executes self-contained JavaScript and TypeScript source declarations from the session's content snapshot. The [browser runner](../games/scripting/browser.ts) creates a disposable module Worker per invocation. Inside that Worker, a fresh QuickJS WebAssembly module, runtime and context execute creator code; no browser, Node, filesystem, network, storage, Tauri or credential objects are bridged into the interpreter. Only JSON state, the state schema, script sources and the requested Action are sent. There are no host function callbacks. QuickJS's module loader is disabled. Bundled self-contained code follows the same boundary; runtime imports and external module fetching are unavailable.

QuickJS is loaded from the pinned `quickjs-emscripten-core` and `@jitl/quickjs-singlefile-browser-release-sync` packages. The single-file variant embeds its WASM, so no CDN or separate WASM URL is needed. The existing TypeScript compiler is bundled as a lazy Worker chunk and only loaded for TypeScript scripts. Transpilation removes types; it does not perform semantic type checking. Runtime schema validation remains authoritative. See the upstream [runtime API](https://github.com/justjake/quickjs-emscripten/blob/main/doc/quickjs-emscripten-core/classes/QuickJSRuntime.md) and [variant documentation](https://www.npmjs.com/package/@jitl/quickjs-singlefile-browser-release-sync).

Scripts register synchronous Actions through the frozen `helia` API. Each script runs in its own strict function scope, in script-ID order, sharing only the isolated VM global. Supported source languages are `javascript`/`js` and `typescript`/`ts`. A registration contains a unique name, a closed argument schema, an optional description, and a `run` function. Registration closes before invocation. Duplicate or invalid registrations fail the invocation even when script code catches the registration error.

```javascript
helia.defineAction({
	name: 'buyItem',
	description: 'Buy an item',
	arguments: {
		type: 'object',
		properties: { price: { type: 'integer' } },
		required: ['price'],
		additionalProperties: false
	},
	run({ state, args }) {
		if (state.gold < args.price) throw new Error('Insufficient gold');
		state.gold -= args.price;
		return state;
	}
});
```

The `state` supplied to `run` is a detached proposal, and `args` is deeply frozen. Return the complete next state. No authoritative data changes until the host validates and commits that result. Promises, class instances, sparse arrays, accessors, functions, non-finite numbers and other non-JSON results fail instead of being silently converted by JSON serialization. Error handling never inspects or stringifies creator-thrown values in the host.

Application callers use `executeSessionAction(gameId, sessionId, { expectedRevision, action: { name, args } }, { signal })` from the shared game repository. It loads the selected progress and frozen content, executes outside any SQL transaction, validates the result and commits one transaction event with its optional creator description. The final write checks the original session revision and snapshot again. Branch selection, history deletion or another state commit while execution is pending causes a conflict; a canceled or failed Action cannot publish its proposal. Cancellation is accepted before the commit operation begins; it cannot undo an already committed event. Restoration replays logged results without executing scripts or delivering UI events again. The production runner is shared by web and the desktop WebView; server-side callers must explicitly supply a trusted `ActionRunner` and never evaluate creator code through native JavaScript `eval`.

### Filters, Hooks and atomic work

`helia.defineFilter({ name, priority?, actions?, run })` registers a proposal check. It returns `{ allow: true }` or `{ allow: false, reason?: string }`. Its context contains deeply frozen `before`, `after`, `changes`, `action` and `state` (the proposed `after` state). It cannot change the proposal or emit UI events. Exceptions, invalid decisions and rejected proposals abort the entire atomic scope. A rejection reports its rule name, script ID and bounded creator-provided reason.

`helia.defineHook({ name, mode?, priority?, actions?, run })` registers a state-change reaction. `mode` defaults to `included`; `independent` requests a separate scope after commit. A Hook receives the frozen trigger context and a read-only `state` containing the latest accumulated state. `before` and `after` still describe the triggering step, even when preceding Hooks have changed `state`. Return an array of `{ name, args }` Action requests, or return nothing for an event-only reaction. Hooks change state by requesting registered Actions; their context is immutable. Hooks run only when the triggering scope changes state. Omitting `actions` matches every Action; an explicit array restricts matching to those Action names.

The following scheduling rules are current implementation policy, separate from the product specification's remaining scheduling questions:

1. Script registration follows script-ID order. Filters and Hooks run by ascending integer `priority` (default `0`, range `-10000` to `10000`), with registration order breaking ties.
2. An Action's arguments and proposed state are validated, then matching Filters inspect the proposal. Only accepted state enters the detached workspace.
3. Matching included Hooks run in order. Their requested Actions run depth-first, in array order, through the same schema, Filter and Hook checks. Later work reads all preceding accepted temporary changes. Re-entering an Action already on the active chain is rejected.
4. If included Actions ran, matching Filters also inspect the aggregate transaction outcome. A failure anywhere discards every state change and buffered UI event. The root Action and all included work produce one event with the net change set; included steps create no branch points.
5. After the root SQL commit succeeds, its UI events are delivered and matching independent Hooks are queued from the aggregate committed change. Independent code never runs against an unresolved proposal.
6. Independent jobs run FIFO, each in a fresh VM using current committed state and a new revision check. The job's Actions and included Hooks form one new atomic event named `hook:<name>`. Failure discards that job's work and events, preserves earlier commits and continues sibling jobs. Cancellation or branch/revision conflict stops the remaining queue. Independent Hook reentry along an ancestor chain is rejected.

The [rule orchestrator](../games/scripting/rules.ts) uses the common detached workspace. The [execution coordinator](../games/scripting/execution.ts) owns commit boundaries and independent scheduling. `commitSessionTransaction` also runs creator rules for direct state proposals, and message commits use the same rule path when scripts are present; these entry points cannot bypass creator Filters. Both accept an optional final `{ signal }` argument. Games without scripts retain the existing synchronous validation and short-commit path.

```javascript
helia.defineFilter({
	name: 'nonnegativeGold',
	run({ after }) {
		return { allow: after.gold >= 0, reason: 'Insufficient gold' };
	}
});

helia.defineHook({
	name: 'purchaseReward',
	actions: ['buyItem'],
	mode: 'included',
	run() {
		return [{ name: 'awardReward', args: {} }];
	}
});

helia.defineHook({
	name: 'purchaseNotice',
	actions: ['buyItem'],
	mode: 'independent',
	run() {
		helia.emit('purchaseCompleted', {});
	}
});
```

`helia.emit(name, payload)` buffers a named JSON-object UI event during Action or Hook execution. `subscribeSessionEvents(gameId, sessionId, listener)` returns an unsubscribe function. Delivery supplies a frozen event with its game, session and committed transaction IDs. It occurs only after the corresponding SQL commit, including for independent scopes. Synchronous listener failures are counted and isolated; accidental Promise returns are treated as delivery failures and their rejections are consumed. Listener code must not block. These are ephemeral UI notifications, with no durable outbox or replay after restart.

`executeSessionAction` returns normal history fields plus `execution: { rootTransactionId, independent, deliveryFailures }`. Independent outcomes distinguish committed, failed and skipped jobs with bounded error codes and rule details. A failure after the root commit is reported here instead of throwing an apparent root failure that could prompt a duplicate retry. Direct scripted state commits return the same optional report. Independent scheduling is local to that invocation; pending jobs are not resumed after a process restart.

Current host limits are 500 ms for interpreter execution, 16 MiB for its heap and 256 KiB for its stack; a separate 15-second Worker watchdog also bounds startup, TypeScript transpilation and cleanup. Each scope accepts at most 32 scripts with 512 KiB of combined source, 256 registrations per kind, 64 Action steps, 128 Hook invocations, depth 16, 128 buffered UI events and 2 MiB JSON wire messages. One invocation may commit at most 16 independent follow-up jobs. At most four Workers run concurrently. The heap limit covers QuickJS allocations, not the Worker, WASM module or TypeScript compiler's total browser memory. Every success, failure, cancellation and watchdog expiry terminates its Worker. Failures report bounded codes, script IDs, rule IDs and Filter rejection reasons without raw host exception messages.

This game-logic runtime provides Actions, Filters, included/independent Hook chains and commit-dependent UI event delivery. The [Preact UI and workbench](../games/ui/README.md) connect panels to these validated operations and publish successful session changes to live views. Arbitrary synchronous nested calls from inside an Action and asynchronous creator logic APIs are not part of this runtime. Self-contained external bundles use the same registrations and permission boundary; importing distributable package files is a later stage. Existing sessions use their current content until an explicit, successfully validated authoring Apply replaces it atomically.

Native storage, API-connection and AI-generation calls use main-frame-only JavaScript closures carrying a random per-process credential. The Rust commands check the credential before accessing storage or starting provider requests. Application command ACLs grant only these three application commands and do not grant general core commands; opaque game UI frames receive no credential. This avoids relying on iframe-origin reporting, which differs between native WebViews.

## Development checks

```powershell
pnpm test
pnpm test:native
pnpm check
pnpm build:web
pnpm build:desktop
```

The native test command uses Tauri's MockRuntime and actual SQLite files without loading a GUI runtime. Repository tests exercise the production SQLite adapter; browser UI tests use a detached in-memory test transport.

`pnpm db:generate` generates SQL from the Drizzle schema. Before stage 10, consolidate schema changes into the initial schema and test both hosts with a fresh database rather than retaining incremental migration history. Generating SQL alone does not change the initialization logic in either host. This policy does not introduce automatic deletion of existing databases.
