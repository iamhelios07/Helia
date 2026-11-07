# Game UI and workbench

Helia owns chat, history and authoritative game state. An optional `Game.ui` describes a **single Preact entry point with packaged JSX/TSX/JS/TS modules**. One opaque-origin iframe runs that entry once and renders its registered panel contents. Trusted Svelte headers, split handles and docking controls sit above that frame; the host sends only visible panel rectangles to the renderer. Creator code cannot access the host controls or write player layout through the bridge. Preact is pinned to 11.1.1. Source is transpiled using the existing TypeScript dependency; it is never executed in the host.

Game UI is part of the session's content snapshot, alongside scripts, resources and state schema. Explicitly applying authored changes updates existing sessions atomically. Games without UI retain the existing chat experience.

The play sidebar keeps its **Sessions / Game** switch. **Game** provides **Open game editor** and quick name/description editing. The separate game editor page returns to the same active play session without creating another session.

## Authoring IDE

The editor uses a project explorer, closable document tabs, a central form/source area, a collapsible execution preview and a bottom inspection area. Game information and instructions use forms. One canonical `state.json` authoring document contains separate `schema` and `initialState` fields. Its recursive visual editor updates that same JSON text bidirectionally, including optional presence, nullable values, objects, arrays and enums. Invalid JSON remains editable in source mode. Earlier drafts with separate schema and initial-state sources are combined without discarding unfinished source. Script and UI modules have individual source editors, generated `GameState` declarations and TypeScript diagnostics. Raw JSON remains available for every document; language-server completion is not provided.

State authoring aligns each field's name, type, initial value and required presence in one row. Object and array rows expand into their structure; arrays distinguish the shared item schema from actual initial items. A selected field reveals annotations, nullability and enum settings inline. Document annotations remain available through document settings. Collapsing a row never changes its data, and initial inputs beneath an omitted or null object stay disabled until the parent has an object value.

Raw document text, including incomplete or invalid JSON, autosaves independently of applied content. Web drafts use a server-side `editor_drafts` SQLite table through `/api/games/[id]/draft`; desktop drafts use the matching local SQLite table through the private main-frame storage bridge. Revision checks reject stale writers, including stale deletion attempts. The former `helia:editor-draft:<gameId>` local entry is a secondary recovery cache. Drafts retain their original applied content for content-conflict detection. Failed loads never overwrite the saved draft, and failed saves retain visible input for retry. Legacy recovery is removed only after the replacement draft is durably saved. Discarding a draft requires modal confirmation.

The explorer and preview widths and inspection panel height can be resized with pointer handles or arrow keys. Their preferred sizes persist per game/device under `helia:editor-layout:<gameId>`, independently of game content and drafts. Smaller viewports clamp the displayed sizes while preserving the preferred sizes. Collapsing the inspection panel preserves its expanded height. The central editor can also split horizontally to edit a second document alongside the main document. Scrollbars use a compact 6px track where supported.

**Apply** validates the draft and commits authored fields and affected sessions in one storage operation. Changes made elsewhere reject a stale apply, while switching the active play session alone does not invalidate a content draft. Each initialized session receives a new content snapshot and validated restoration checkpoints for every recorded branch. Field additions use new initial values, removals drop fields, and changed types attempt conversion before using the new initial value. Failed validation on any branch cancels the entire apply. Original transaction and message records stay unchanged; restoration uses checkpoints without executing creator scripts again. History deletion purges associated checkpoints as well. Inputs lock while applying. Draft cleanup failures cannot turn an already committed apply into a reported game-write failure. Player API credentials and global prompt presets are outside authored documents.

Live preview runs the actual Preact UI and game logic through the existing opaque-origin iframe and QuickJS runner in an isolated in-memory repository. Valid draft changes restart preview after a debounce; invalid edits retain the last valid preview. A separate test playthrough keeps its own progress until explicitly restarted, and shows when its content is outdated. Neither mode adds normal play sessions or writes normal game progress. BYOK tests use fresh host lease scopes and the same agent loop/provider transport. Action, Filter, Hook, UI and AI failures appear in diagnostics, and committed test state and history can be inspected. Test progress lasts until restart or editor teardown.

Resources are portable data URIs, validated by both storage hosts: PNG/JPEG/WebP/GIF, supported audio and video, at most 1 MiB each and 3 MiB total. The asset editor supports file selection, preview, names and modal-confirmed deletion. Creator UI uses `helia.asset('resource-id')` or the `asset` export from `@helia/ui`. SVG, HTML and network URLs are not resource payloads. Start the production web server with `pnpm start`, which defaults `BODY_SIZE_LIMIT` to 20 MiB for content and draft requests; an explicitly configured limit takes precedence.

## Workbench structure

The workbench has **one split tree containing both trusted chat and creator panels**. There is no separate outer chat split enclosing a second panel workspace. With no authored defaults, chat occupies the main area, the first panel sits on the right, and the remaining panels share the bottom of the main area. These are initial positions: players can move chat or any panel beside, above or below any other leaf. App navigation and session management remain outside this game-specific canvas. No workspace tabs are introduced.

Responsibilities are separated as follows:

- `GameWorkbench.svelte` owns the session-scoped runtime lifecycle, busy state, errors and snapshot UI.
- `GamePanelSurface.svelte` owns the unified visible tree, player preferences, drag previews and geometry measurement. It renders the chat snippet once in a trusted host positioned over its measured leaf; docking preserves the chat DOM, draft, focus and scroll.
- `PanelLayoutNode.svelte` renders recursive host headers, content placeholders and accessible split handles. Creator placeholders pass pointer input through to the underlying iframe; chat and controls stay in the trusted host.
- `workbench-preferences.ts` owns defaults, reconciliation, docking, resizing, validation and versioned device persistence. The internal `$chat` leaf cannot collide with the restricted creator panel ID format.
- `runtime/bridge.ts` sends **creator body rectangles only** to a single full-canvas opaque iframe. Moving a leaf changes its rectangle without restarting the runtime or exposing host chat to creator code.

Headers keep two controls only: the title is the drag handle with edge previews, and a minus button minimizes that creator panel. Reopening hidden panels and restoring creator defaults live in the single workspace menu in the chat header. Panel movement is intentionally provided only by dragging the title; menu-based movement is outside the implementation scope. Minimizing leaves the registration intact and keeps the panel's position and split ratios in the saved tree. Only the visible tree collapses its empty space. Reopening restores that saved placement, including after an application restart. Moving or resizing visible panels updates the corresponding saved nodes without discarding hidden panels. Moving a visible panel changes its relationship to hidden siblings; reopening uses the resulting saved tree rather than undoing subsequent player edits. Routine play does not show permanent layout forms. The trusted chat always remains available and cannot be minimized.

## Content and registration

Pass an optional `ui` to `updateGameRules` together with the game's schema, initial state and scripts. No database migration or new table is required: validated UI content is stored in game and snapshot JSON on both web and desktop.

```ts
const ui = {
	version: 1,
	entry: 'main.tsx',
	modules: {
		'main.tsx': {
			language: 'tsx',
			source: `
import { registerPanel, useGameState, useUIState, Button, Progress } from '@helia/ui';

function Status() {
  const state = useGameState();
  return <Progress label="Health" value={state.hp} max={100} />;
}
function Controls() {
  const [selected, setSelected] = useUIState('controls.selection', 'rest');
  return <Button onClick={async () => {
    await helia.action('rest', {});
    setSelected('rest');
  }}>Rest ({selected})</Button>;
}
export default function () {
  const removeStatus = registerPanel({ id: 'status', title: 'Status', component: Status });
  const removeControls = registerPanel({ id: 'controls', title: 'Controls', component: Controls });
  return () => { removeControls(); removeStatus(); };
}
`
		}
	},
	layout: {
		kind: 'split',
		axis: 'horizontal',
		ratio: 0.4,
		first: { kind: 'panel', id: 'status' },
		second: { kind: 'panel', id: 'controls' }
	},
	chatDock: 'left',
	chatRatio: 0.6,
	chatStyle: { fontFamily: 'serif', assistantBackground: '#282333' }
};
```

The example expects a declared `hp` state field and a registered `rest` Action in the game's logic scripts. UI rendering, resizing and local UI State do not call AI or create game transactions. Explicit [AI invocation](../ai/README.md) is available through `ai(text, { visible })`; the UI editor belongs to the later authoring stage.

Import `preact`, `preact/hooks`, `@helia/ui` or another packaged relative module (`./Status`, `./Status.tsx`). Static exports and circular packaged imports are supported. External packages, network imports, dynamic imports, `require`, `import.meta` and top-level `await` are unavailable. The optional default entry initializer is synchronous and may return a disposer. Registering panels at module scope is also supported. Imports do not grant access to the application's modules.

Preact 11 core requires explicit units for CSS lengths in object styles, for example `width: '240px'` or `padding: '12px'`. Unitless CSS properties such as `opacity` and `fontWeight` can remain numbers. The runtime likewise uses explicit pixel strings for host-provided panel rectangles.

## UI interface

The same interface is available as global `helia` and as named exports from `@helia/ui`.

| Interface                                                | Behavior                                                                                                                    |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `registerPanel({ id, title, component })`                | Register a Preact function component; returns an unregister function. Dynamic registration/removal uses the same interface. |
| `getState()` / `subscribeState(listener)`                | Read deeply frozen committed state; subscribe returns an unsubscribe function.                                              |
| `useGameState()`                                         | Preact subscription with automatic cleanup when its component unmounts.                                                     |
| `action(name, args)`                                     | Request a registered game Action; the host applies schema, Filter, Hook and revision checks.                                |
| `ai(text, { visible })`                                  | Explicitly invoke the player's default AI model; defaults to an internal event.                                             |
| `transaction({ name, args }, nextState)`                 | Submit one complete state proposal through the same validated commit path.                                                  |
| `onEvent(name, listener)` / `useUIEvent(name, listener)` | Observe committed UI event payloads. The first returns an unsubscribe function; the hook cleans up on unmount.              |
| `useUIState(key, initialValue)`                          | Shared transient JSON state; returns `[value, setter]` and supports functional setters.                                     |
| `onDispose(callback)`                                    | Register entry-wide cleanup; returns a function that unregisters the cleanup.                                               |
| `Button`, `Text`, `Progress`                             | Basic Preact presentation components; ordinary Preact elements remain available.                                            |
| `Inventory({ items, renderItem, label })`                | Render creator-owned items without assuming an inventory state schema or rules.                                             |
| `Stats({ items, label })`                                | Render `{ label, value }` pairs without defining game statistics or mechanics.                                              |
| `QuestList({ items, renderItem, label })`                | Render creator-owned quest entries without enforcing quest progression.                                                     |

Manual subscriptions belong in a Preact effect returning their unsubscribe function, or in entry cleanup. Hook subscriptions clean up automatically. UI requests reject on invalid input, conflicts, a busy host or cancellation; callers should handle rejection. Await a successful request before starting another. No keys, providers, model client or general host executor are exposed.

## Layout and UI State

- Existing creator `layout`, `chatDock` and `chatRatio` defaults are converted into a unified tree. They specify initial placement without restricting later docking across chat. A split is horizontal or vertical; its ratio is between 0.1 and 0.9. Panel IDs are unique.
- Players dock chat and panels left/right/top/bottom of another leaf, resize with a pointer or keyboard, close/reopen creator panels and restore creator defaults. Hiding all creator panels leaves the chat filling the canvas.
- New dynamic panels append to an available creator leaf without rearranging survivors or subdividing the main chat. Removing a panel collapses its empty split and unmounts its subscriptions. Metadata updates do not overwrite the saved layout, so temporarily absent or hidden registrations retain their preferences. Reopening restores values stored through `useUIState`; ordinary Preact component-local state follows normal mount/unmount lifetime.
- Player layout persists **per game and device** in `localStorage` under `helia:workbench:<encodedGameId>` as `{ version: 2, tree, hidden }`. The tree includes minimized panels; `hidden` controls only visibility. Saved slots for absent registrations may be reused when needed to keep the tree within sixteen creator panels; currently registered minimized panels retain their slots. The former two-key settings are read together for compatibility and written in the unified format on player edits; reset clears both formats. Storage failures do not undo game transactions. Layout is independent of global navigation sidebar preferences.
- Shared UI State and panel scroll positions remain in memory per game/session during this app execution. Returning to the session restores them. A restart resets them. They never enter game state, transactions, branches, memory or package data.
- Repository observers refresh panels and chat after commits, checkout and deletion. State-only background updates preserve chat scroll and drafts. UI events follow a refresh of committed state; branch restoration does not replay events. Deletion dialogs retain their original expected revision during background refresh.
- Chat content, sending, history and deletion stay under Helia's control. Creators may set individual validated colors/font values; these take precedence over inherited personal styles. Stylesheets, resource URLs and selectors are not accepted.

## Isolation and limits

The iframe has `sandbox="allow-scripts"` without same-origin, top-navigation, popups, downloads or form permissions. Its CSP blocks fetch/WebSocket, subframes, external script/style/media resources and forms. Preact, hooks and packaged source are inlined. MessageChannel traffic is bounded and validated; the host checks current revisions and remains the only state writer. Leaving the frame's initial document terminates its bridge. Disposal aborts outstanding work, unmounts components, closes ports and removes subscriptions.

Limits: 16 creator panels, 32 modules, 512 KiB total authored source, creator layout depth 8 (unified host layout depth 9 including chat), 2 MiB bridge messages and 256 KiB transient UI State per session. Startup has a 15-second timeout and bridge requests have a 30-second response timeout.

Browser DOM execution has different limits from the QuickJS game-logic sandbox: iframe code has no guaranteed CPU/memory quota, and a non-yielding loop may stall its browser process. CSP does not reliably prevent a frame initiating its own navigation; the navigation handler terminates the bridge after the load, not the initial network request. This implementation isolates host data and privileges, but does not claim the iframe provides process-level isolation or an absolute network boundary. Do not weaken the sandbox by adding `allow-same-origin`.

Some desktop WebViews inject Tauri's IPC machinery into subframes or cannot reliably distinguish an iframe's origin. Native storage therefore requires a random per-process credential held in a **main-frame-only closure**. Only `window.__HELIA_STORAGE__(request)` in the trusted host can attach that credential; UI modules and MessageChannel data never receive it. The Rust command checks it before database access. Application capabilities grant only the storage, credential and AI-generation commands, with no general core permissions; each command checks the same private main-frame access boundary. This complements [Tauri's command capability checks](https://tauri.app/security/capabilities/) rather than relying on the iframe origin alone.

## Verification

`pnpm test` covers real opaque-origin iframe execution, multi-module TSX panels, committed state/events, subscription removal, invalid transactions, UI State remount/session isolation, layout manipulation and persistence, content snapshots and live chat/history regression cases. `pnpm test:native` validates the matching native content contract. Run `pnpm check`, ESLint and both build targets after changing the interface.
