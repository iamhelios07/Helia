# Helia Specification

This document defines the required product behavior of Helia, a platform for creating and playing AI-powered roleplaying games.

Requirements describe the intended product, not the completion status of the current implementation. Development policies, implementation milestones, database design and verification results are outside this document's scope.

Pseudocode describes observable behavior and consistency requirements. It does not prescribe public API names, storage structures or a particular execution algorithm. Unresolved product decisions are listed under Open Questions; examples do not resolve those decisions.

# Keywords

The uppercase requirement keywords follow [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174). Lowercase uses have their ordinary English meanings.

- **MUST**, **REQUIRED**, **SHALL**: an absolute requirement.
- **MUST NOT**, **SHALL NOT**: an absolute prohibition.
- **SHOULD**, **RECOMMENDED**: the expected behavior unless a justified exception is understood and accepted.
- **SHOULD NOT**, **NOT RECOMMENDED**: behavior to avoid unless a justified exception is understood and accepted.
- **MAY**, **OPTIONAL**: permitted behavior that is not required.

Prohibitions use MUST NOT. This specification does not use MAY NOT or IN ANY CASE as requirement keywords.

# Product Definition and Scope

- Helia MUST allow creators to define games and players to play those games using their own AI API credentials (BYOK).
- Natural-language conversation and game UI interactions MUST operate on the same session and game world.
- Creators MUST be able to define game mechanics, content, presentation and interactions without modifying Helia itself.
- Helia MUST NOT require a particular genre, fixed statistics, inventory system, turn structure or AI role. A game MAY use these features when its creator defines them.
- Helia MUST support web and desktop applications. Web data MUST be stored on the server; desktop data MUST be stored on the player's computer.
- The product assumes a single user and single-player gameplay. Multiple user accounts, multiplayer, mobile-first support, automatic cross-device synchronization and an in-app game community are outside the scope of this specification.
- Players MUST be able to transfer supported game and play data between web and desktop through explicit file export and import.
- Every user-initiated deletion MUST require explicit confirmation through a modal dialog before the deletion is performed. This requirement applies throughout the product, including installation, session and history deletion. The confirmation MUST cover the scope of any cascading deletion.

# Core Concepts

| Term         | Meaning                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| Creator      | A person who defines a game's content, rules, UI and behavior.                                           |
| Player       | A person who installs and plays a game. A player MAY also edit an unlocked game.                         |
| Game         | The creator-authored content and rules that define an independently playable experience.                 |
| Game Package | A distributable file containing a game and the resources needed to install it.                           |
| Installation | A locally identified copy of a game, created directly or imported from a package.                        |
| Session      | An independent playthrough of one installed game, with its own state, history and branches.              |
| Game State   | Structured, persistent facts about the game world, authoritative within a session.                       |
| UI State     | Transient presentation state such as selected tabs, scroll positions and open dialogs.                   |
| Action       | A creator-defined operation identified by its name and arguments, regardless of what invokes it.         |
| Schema       | A declaration of permitted state structure and types.                                                    |
| Filter       | Creator-defined logic that accepts or rejects a proposed transaction without correcting its data.        |
| Hook         | Creator-defined logic that reacts to changes or events and performs follow-up work.                      |
| Transaction  | An atomic unit that commits validated state changes and their associated record.                         |
| Event        | A committed message or transaction that can participate in session history.                              |
| Branch       | A continuation of session history sharing an earlier history with another continuation.                  |
| Agent Loop   | One AI request that can include multiple tool calls and produces one atomic scope of game-state changes. |
| Memory       | Derived narrative information grounded in conversation, game events or both.                             |

An original game identifier, an installation identifier and a content version MUST be treated as distinct concepts. Sessions of the same game MUST have independent progress; shared game content MUST NOT imply shared session state.

# Game Management

## Creation and Library

- Creators MUST be able to create a game as an empty project. A fixed RPG template MUST NOT be a prerequisite.
- Helia MUST provide a library in which users can list, search, sort and open installed games.
- Creators MUST be able to edit game metadata separately from instructions supplied to the AI. Changing a public description MUST NOT implicitly redefine the AI prompt.
- A game MUST be self-contained with respect to its creator-defined rules and content. It MUST NOT require access to another installed game's private data.
- Users MUST be able to delete an installation. Deleting an installation MUST also delete all sessions associated with that installation.
- Confirmed installation deletion MUST move the installation and its associated sessions to Trash together, removing them from active use rather than immediately purging them permanently.

## Identity and Versions

- Each newly created or separately imported installation MUST receive an independently generated random identifier for its `/games/[id]` route.
- An installation's route identifier MUST NOT be derived from the game title or used as the original game's identity.
- A distributable game MUST have an original game identifier. Its content version MUST use Semantic Versioning (SemVer).
- An installation MUST retain the original identity and content version needed to identify its source.
- Helia MUST allow different installed versions of a game to coexist. Installing a new copy MUST NOT implicitly replace an existing installation.
- Rules for repeated imports while an active installation with the same original identity and content version still exists remain open; the identity/version pair alone does not establish a confirmed uniqueness rule.
- Importing a game after its previous installation was deleted MUST behave like importing a new game. It MUST receive a new installation identifier and MUST NOT implicitly restore or reconnect the deleted installation's sessions. A matching item in Trash MUST NOT cause the import to be treated as an upgrade or restoration.

# Sessions and Gameplay

- Players MUST be able to create multiple independent sessions for one installed game.
- Players MUST be able to select, rename, resume and delete sessions.
- A new session MUST begin from the creator-defined initial state and authored opening message when one is provided.
- Creators MAY define a custom start flow, such as character creation or difficulty selection, using supported scripting and UI facilities.
- Game-state changes performed during a custom start flow MUST obey the same validation and transaction rules as later gameplay.
- Committed session progress MUST survive closing and reopening the application.
- Resuming a session or selecting a branch MUST restore its corresponding conversation, game state and valid memories together.
- Helia MUST distinguish an operation in progress from one that has successfully committed. A failed operation MUST NOT appear as a successful state change.

# Game State and Actions

## State Schema and Initial State

- Each game MUST define its state schema and initial state as separate fields in the same authoring document.
- The game-state document MUST use an object as its root state; primitive, array and nullable schemas MAY be nested within its fields.
- The canonical schema MUST be JSON-based and use a documented subset of JSON Schema.
- The supported subset MUST include `string`, `number`, `integer`, `boolean`, `null`, objects with explicitly typed fields and arrays whose items share one schema.
- Supported structural keywords MUST include `type`, `properties`, `required`, `additionalProperties: false` and `items`. `enum` MUST be supported, and `title` and `description` MUST be supported as authoring annotations.
- `type` MUST accept a single supported type or a two-type array containing one non-null type and `null`. Other type unions are outside the supported subset.
- Optional field presence and nullable values MUST remain distinct: `required` controls presence; nullable types control whether a present value may be `null`.
- Every object schema MUST declare `properties` and `additionalProperties: false`. A field not listed in `required` MAY be omitted. Each array schema MUST declare one `items` schema, which MUST apply to every item, including nested objects and arrays.
- `enum` MUST be nonempty and contain distinct values satisfying its declared type and structure.
- Initial values MUST be defined in `initialState`, not a schema `default` keyword. Normal validation MUST NOT coerce values or insert missing values; game-content migration follows its separate transformation rules.
- References (`$ref`), recursive schemas, schema combinations (`oneOf`, `anyOf`, `allOf`, `not`), conditional schemas, tuples and schema keywords for numeric ranges or string patterns are outside the supported subset. Such constraints MAY be expressed through Filters where applicable.
- Undefined fields MUST be rejected by default, including fields in nested objects.
- Unsupported schema syntax MUST produce an explicit diagnostic rather than being silently ignored.
- Initial state MUST satisfy its schema before it can initialize a playable session.
- Loaded state and proposed final state MUST be validated against the schema applicable to that state.
- Tool arguments MUST be validated against the tool's declared argument contract before execution.
- Runtime validation MUST NOT be replaced by generated TypeScript types or trust in model-generated data.
- Numeric bounds, reference integrity and other game rules SHOULD be expressed through Filters rather than being conflated with structural type validation.

The following is an illustrative authoring document, not a complete schema dialect or a fixed file format:

```json
{
	"schema": {
		"type": "object",
		"properties": {
			"player": {
				"type": "object",
				"properties": {
					"hp": { "type": "number" },
					"level": { "type": "integer" }
				},
				"required": ["hp", "level"],
				"additionalProperties": false
			}
		},
		"required": ["player"],
		"additionalProperties": false
	},
	"initialState": {
		"player": { "hp": 100, "level": 1 }
	}
}
```

## Validation and Atomicity

- Game State MUST be the authority for structured facts about the session. AI narration and direct UI object mutations MUST NOT independently change authoritative state.
- All persistent game-state changes MUST pass through the transaction system, regardless of whether they originate from UI, AI or creator scripts.
- A Filter MUST accept or reject a proposed transaction. It MUST NOT silently alter the proposal to make it acceptable.
- A transaction MUST either commit every change in its atomic scope or commit none of them.
- An atomic operation with an unresolved schema failure, Filter rejection or failure of an included Hook MUST NOT commit. A failed attempt MUST NOT leave partial changes that can be committed without satisfying the same validation rules.
- Associated transaction records and transaction-dependent UI events MUST NOT survive as successful results when their state changes fail.
- A proposal based on stale session progress MUST NOT overwrite newer progress. A conflict MUST be reported rather than silently replacing that progress.
- Temporary changes MUST remain distinct from committed state. Later operations within the same atomic scope MUST be able to read its accumulated temporary state.

```text
function commitAtomicWork(session, expectedRevision, work):
    base = readCommittedProgress(session)
    require base.revision == expectedRevision
    workspace = detachedCopy(base.state)
    pendingEvents = []

    try:
        executeWork(workspace, work, pendingEvents)
        require allApplicableSchemaFilterAndIncludedHookConditionsPass()

        result = commitTogetherIfRevisionMatches(
            session,
            expectedRevision,
            workspace,
            associatedRecords(work)
        )
        require result.succeeded
    on failure:
        discard(workspace, pendingEvents)
        return failure

    deliver(pendingEvents)
    return success
```

The example specifies an atomic boundary, not the detailed ordering of Filters and Hooks.

## Hooks

- Hooks MUST be able to react to state changes and trigger further supported operations.
- Hook-generated transactions MAY be included in the originating transaction or run independently, according to their declared execution contract.
- Included Hooks MUST share the originating atomic scope. Their failure MUST roll back that scope.
- Hook chains MUST be supported. Execution SHOULD have finite depth and count limits to prevent unbounded chains.
- Independent execution MUST NOT be used to leak otherwise uncommitted changes from an atomic agent loop.
- Hook ordering, independent failure behavior and exact execution limits remain open.

# History and Branching

## Events and Navigation

- Players MUST be able to navigate history using messages and committed game transactions.
- Intermediate steps within the same atomic operation MUST NOT be separate branch points. Uncommitted tool calls MUST NOT be branch points.
- Creating a continuation from a past event MUST preserve the previous future and create a new branch.
- Committed transaction records MUST NOT be edited in place to replace a historical game outcome. A different outcome MUST be represented by a new continuation from an appropriate earlier event. Representation changes required by game-content migration are subject to the migration requirements below.
- Helia MUST NOT merge branches.
- Restoring history MUST use recorded outcomes without rerunning AI, Hooks or random decisions.
- A selected event MUST resolve to a consistent conversation and state boundary. How messages and transactions belonging to the same atomic operation are represented in history is an implementation choice; that representation MUST preserve the atomic branching boundary.
- A transaction and any message committed with it MUST be navigated and deleted as one atomic event. A message without state changes and a transaction without a message MUST also be representable in history.

## Deletion

- Deleting an event MUST delete that event and all descendant events, including descendants on other continuations originating from that event.
- Deletion MUST preserve earlier events still shared by surviving paths.
- Associated messages and derived data MUST be removed or invalidated consistently with the deleted history.
- Deletion MUST NOT leave the selected progress or usable memories referring to deleted events.
- If deletion removes the selected event, Helia MUST select the deleted subtree root's surviving parent, or the initial state if there is no parent. Otherwise, the selected event MUST remain unchanged.
- Moving to a past event and deleting an event MUST be distinct operations. Merely changing the selected head MUST NOT be presented as deletion.
- History deletion MUST follow the product-wide confirmation-modal requirement. The installation Trash requirement does not establish a recovery guarantee for deleted history events.

```text
A - B - C - D
     \
      E - F

delete(B) => remove B, C, D, E, F; preserve A
delete(E) => remove E, F; preserve A, B, C, D
```

```text
function deleteEvent(history, event):
    removed = {event} union descendants(history, event)
    surviving = history.events minus removed
    selected = event.parent if history.selected in removed else history.selected

    if not confirmDeletionInModal(removed):
        return canceled

    atomically:
        removeEventsAndTheirOwnedData(removed)
        invalidateDerivedDataDependingOn(removed)
        preserveSharedPredecessors(surviving)
        restoreConversationStateAndValidMemories(selected or initialState)
```

## Transaction Display

- Helia MUST display a human-readable summary of each transaction.
- A creator-provided description MUST take precedence over the automatic summary.
- If no description is supplied, Helia MUST generate a rule-based summary from the recorded changes. This MUST NOT require an additional LLM call.
- Players MUST be able to expand a record to inspect changed fields, before/after values and raw recorded data.

# AI and Conversation

## Providers, Prompts and Tools

- Players MUST supply their own API credentials and choose the provider and model from supported integrations.
- Helia MUST leave model selection to the player rather than granting a creator the ability to force a particular model.
- The creator's prompt MUST determine the AI's role, including whether it acts as a game master, one character or multiple characters.
- Prompt authoring SHOULD follow the RisuAI-style prompt management model. The exact supported slots, ordering rules, lorebook behavior and variables remain open.
- Helia MUST support repeated tool calls and follow-up model responses within one agent loop.
- For models without native tool calling, Helia SHOULD support a structured text/JSON fallback. The supported model capabilities and fallback contract remain open.
- AI state writes MUST be restricted to creator-authorized tools by default.
- A creator MAY enable broader state-writing tools, but those tools MUST NOT bypass Schema, Filter or Transaction requirements.
- The AI MUST be able to retrieve permitted state details through tools.
- Committed game changes MUST be represented in AI context using transaction information. A current-state summary MUST appear at the bottom of the assembled game context.

## Atomic Agent Loop

- One AI request and its sequence of state-changing tool calls MUST share one atomic scope of game-state changes.
- Subsequent tools in the loop MUST see temporary changes made by earlier successful tools in that loop.
- Tool failures MUST NOT expose failed partial changes as committed state.
- When the loop ultimately fails, all of its uncommitted game-state changes MUST be discarded.
- Game-state changes MUST remain uncommitted until the final answer finishes streaming successfully. For a non-streaming provider, the complete final answer MUST be received successfully before committing.
- If generation or streaming fails, or the request is canceled before committing, all pending game-state changes MUST be discarded.
- Successful completion of the final answer MUST NOT bypass final validation or conflict checks. If committing fails, no pending game-state changes MAY become authoritative.
- Player operations that change Game State MUST be restricted by default while an AI response is being generated. Pure UI operations need not be blocked by that restriction.
- Creator-defined game operations, including Actions, Hooks and AI-invoked game tools, MUST NOT produce irreversible external side effects. Helia MUST NOT expose capabilities for such operations to perform external actions that cannot be rolled back with the atomic game operation.

```text
function runAgentRequest(session, request):
    workspace = beginAtomicWorkspace(session)

    while moreModelOrToolWorkIsRequired():
        output = obtainNextModelOutput(request, workspace)
        if output.isTerminalFailure:
            discard(workspace)
            return failure
        showPermittedStreamingOutput(output)

        for call in output.toolCalls:
            result = executePermittedTool(call, workspace)
            provideToolResultToModel(result)
            if result.terminatesRequest:
                discard(workspace)
                return failure

    completion = awaitFinalAnswerCompletion()
    if not completion.succeeded or request.isCanceled:
        discard(workspace)
        return failure

    result = validateAndCommitWorkspaceAtomically(session, workspace, request)
    if not result.succeeded:
        discard(workspace)
        return failure

    return success
```

Final validation and commit eligibility MUST include whether the request was canceled before committing. Streamed text alone MUST NOT be treated as evidence that game-state changes have committed.

## Invocation and Presentation

- A game UI interaction MUST NOT automatically invoke the AI unless the creator explicitly configures that invocation.
- Creators MUST be able to request an AI invocation through supported script APIs or component/event configuration.
- For such invocations, creators MUST be able to choose whether to create a visible player message or send an internal event, and what text is displayed.
- Final answers MUST be streamed in real time when the provider supports streaming.
- Provider-supplied thinking text and tool progress MUST appear separately from the final answer in an area collapsed by default.
- When thinking text is available, Helia MUST display the supplied text without requiring a separate summarization call. When unavailable, Helia MUST NOT imply that provider thinking was supplied.
- Sensitive tool-result values MUST be hidden by default.
- Expandable execution diagnostics SHOULD expose relevant tool, transaction, Filter and Hook failures without exposing credentials.
- Interrupted answers and answers whose associated changes have not committed MUST be visibly distinguished from successfully completed and committed responses. They MUST be represented as incomplete or unsent attempts rather than as successful replies.
- The exact visual treatment of incomplete or unsent attempts is an implementation choice. Their continued display MUST NOT imply that the associated game-state changes committed.
- Provider-supplied thinking MAY reveal game secrets. Helia is not required to filter thinking text to conceal those secrets; credential-protection requirements still apply.

# Memory and Context

- Long-term memory MUST extend HypaV3 while preserving its established memory-generation, management and trigger behavior.
- Conversation and committed game events MUST both be eligible memory sources.
- Narrative facts such as promises, relationships and secrets MUST be eligible even when they do not correspond to a structured state transaction.
- When a structured fact conflicts with narrative memory, the authoritative Game State and its committed record MUST take precedence.
- Memories MUST remain attributable to the history from which they were derived so that their validity can be determined for a selected branch.
- Shared past memories MUST be reusable across branches sharing that past.
- Information derived only from one future MUST NOT leak into another future.
- When a new continuation is created from the past, memories belonging to the previous future MUST be excluded from the new continuation. They MUST remain available to the original continuation while it exists.
- Summaries spanning a changed branch boundary MUST be invalidated or reconstructed before being used on the new continuation.
- Memory reconstruction MUST NOT change committed game outcomes.

```text
function memoryIsUsable(memory, selectedHistory):
    return every source needed by memory is valid in selectedHistory
```

This is a validity condition, not a retrieval algorithm. The memory representation, retrieval policy and treatment of summaries combining multiple sources remain open.

# Game UI and Workbench

## Creator-Defined Panels

- Creators MUST be able to write game UI using Preact and JSX/TSX, with game logic in JavaScript or TypeScript.
- A game MUST register its UI through one entry point, which MAY load multiple source files and register multiple panels.
- Static panel registration SHOULD be the default authoring approach. Dynamic registration and removal MUST also be supported.
- Helia MUST provide basic UI components such as buttons, text and progress indicators, and reusable game-oriented presentation components such as inventory, statistics and quest views.
- Presentation components MUST NOT impose a fixed inventory model, stat system or quest mechanic on every game.
- Panels MUST be able to subscribe to the current Game State and request permitted Actions or transactions. They MUST NOT directly mutate authoritative state.
- Removing a panel MUST release its subscriptions and associated runtime resources.

## Layout

- The workbench MUST support dockable panels, horizontal and vertical splits, and resizing.
- Creators MUST be able to define a default layout. Players MUST be able to rearrange it.
- Player layout settings MUST be persisted per installed game and restored after restarting the application.
- The workbench MUST NOT depend on top-level tab-based navigation between game panels. A creator MAY use tabs inside an individual panel.
- Adding a panel MAY resize existing panels as required by available space. Panel registration alone MUST NOT grant creator code unrestricted control over the player's existing arrangement.
- Responsive content within panels SHOULD be preferred over elaborate automatic rearrangement when space is limited.
- Whether chat is fixed in the main central area remains open.

## UI State and Events

- UI State MUST remain separate from persistent Game State and branching history.
- Switching away from and back to a view during the application run MUST preserve its UI State, including selection and scroll position.
- Ordinary UI State MAY reset after application restart. Persisted layout settings MUST follow the layout requirements above.
- Persistent state presentation MUST use state binding or subscriptions.
- One-time effects such as notifications, screen shake and panel visibility requests MUST use UI events or equivalent presentation behavior.
- Transaction-dependent UI events MUST be delivered only after the transaction commits. They MUST be discarded if it rolls back.
- UI effects unrelated to a transaction MAY run immediately.
- AI effects on game UI SHOULD flow through permitted state changes and creator-defined reactions rather than unrestricted direct UI manipulation.

## Chat Presentation

- Helia MUST provide the structural behavior of chat, including messages, streaming, branch navigation and thinking/tool presentation.
- Creators MUST be able to customize chat appearance, including message bubbles, fonts and backgrounds.
- Where creator styling and player styling conflict, creator styling MUST take precedence. Styling MUST NOT bypass runtime permissions.

# Authoring Environment

- Helia MUST provide in-app authoring for game metadata, prompts, state schema, initial state, scripts, UI and resources.
- Creators MUST have direct access to the canonical JSON state document.
- A visual schema editor MUST edit the same source bidirectionally. It MUST NOT maintain an independent schema that can silently diverge from the JSON document.
- The authoring environment MUST generate TypeScript types from the supported state schema for creator code.
- Helia MUST provide code editing and live preview for creator scripts and game UI.
- Creators MUST be able to run a separate test playthrough in addition to live preview.
- Creator diagnostics SHOULD identify schema errors and failed transactions, Filters, Hooks and AI operations with enough context to locate the cause.
- Authoring edits MUST be saved automatically as they are made. Saving a draft MUST NOT apply it to running game content.
- Applying saved edits to the game MUST require an explicit creator action. Until that action succeeds, sessions MUST continue to use the previously applied game content.
- The authoring UI MUST distinguish saved but unapplied edits from the currently applied content. An outdated/unapplied indicator MAY be used; its exact wording and presentation are implementation choices.
- Compatible authoring changes to scripts, prompts and UI MUST be usable by existing sessions without requiring a new session. Previously committed messages and transaction outcomes MUST NOT be rewritten by those changes.
- A schema change incompatible with existing state MUST NOT silently damage or reinterpret that state. It MUST follow the validated game-content migration contract below.
- The timing of an explicit apply request while an AI response, Action or other game operation is already in progress remains open.
- Helia MUST support externally prepared bundles under the same runtime and permission model as in-app authored code.
- The in-app editor MUST NOT provide arbitrary npm package installation or unrestricted external dynamic imports. Creators MAY bundle dependencies in an external development environment before importing them.
- A visual drag-and-drop UI builder is outside the current scope.

Preview reset behavior, source editing for external bundles and the scope of advanced debugging tools remain open.

# Distribution and Updates

## Packages and Installation

- Game distribution MUST support file-based export and import.
- A package MUST represent the game's metadata, identity and content version, prompts, state schema, initial state, creator logic, UI, default layout and referenced distribution resources.
- API credentials, player secrets and private play history MUST NOT be included in a distributable game package.
- Helia MUST validate imported content before making it available for execution. Invalid content MUST NOT partially replace a working installation.
- Packages MUST NOT depend on machine-specific absolute resource paths or temporary browser URLs to identify portable assets.
- The package container, extension, resource-reference syntax and validation limits remain open.
- Distributed games MUST be installed with editing locked by default.
- Players MUST be able to explicitly unlock an installation for editing. Unlocking MUST NOT grant additional runtime permissions to its code.

## Upgrade Choices

- When importing a newer version, Helia MUST offer upgrading an existing installation or installing a separate copy.
- Upgrading MUST replace the selected installation only after all required state transformations and validation succeed.
- Installing a separate copy MUST preserve the existing installation and its sessions and MUST allocate a new installation identifier.
- Helia MUST warn before an upgrade can overwrite local edits to the installed game.
- The product does not guarantee permanent hosting, storage or automatic downloading of every historical game package.

## Game-Content Migration

These requirements concern creator-authored game updates and session state, not Helia's internal database schema.

- When a field is newly introduced by the new state definition, its value MUST be initialized from the corresponding new initial-state value. Existing values of unchanged fields MUST be preserved.
- The same field-addition rules MUST apply recursively inside nested objects and objects contained in arrays.
- Fields removed from the state schema MUST have their values removed from the transformed state.
- When a field's type changes, the default behavior MUST first attempt conversion to the new type. If conversion fails, the corresponding new initial-state value MUST be used.
- These state-transformation rules MUST apply equally to the current branch and to historical branch states. Historical branches MUST NOT follow a different set of field-addition, removal or conversion rules.
- Creators MUST provide any additional game-specific transformations needed beyond these default rules.
- State transformations MUST be validated before they become authoritative.
- An upgrade MUST succeed for every affected session before the installation is replaced.
- If any affected session fails migration or validation, the entire upgrade MUST be canceled and the existing installation and sessions MUST be preserved.
- An interrupted or failed upgrade MUST NOT leave the installation using a mixture of old and new game content or partially transformed sessions.
- Whether existing event records are transformed or preserved with an appropriate compatibility mechanism remains open. The chosen approach MUST preserve the required state-transformation behavior when historical states are restored.

```text
function upgrade(installation, package):
    stagedGame = validateAndStage(package)
    stagedSessions = []

    try:
        for session in affectedSessions(installation):
            candidate = transformUsingGameVersionContract(session, stagedGame)
            require candidateSatisfiesStateAndHistoryRequirements(candidate)
            stagedSessions.append(candidate)

        atomicallyPublish(stagedGame, stagedSessions, installation)
    on failure:
        discardAllStagedChanges()
        preserveExistingInstallationAndSessions()
        return failure

    return success
```

The staging mechanism is an implementation choice. Staging MUST NOT execute untrusted code with host privileges. The treatment of existing event records remains open.

# Data and Permissions

## Persistence and Transfer

- Games, sessions, committed history and the data needed to resume play MUST be persisted in the platform's designated storage location.
- Web and desktop MUST NOT automatically synchronize their data with one another.
- Players MUST be able to explicitly export and import play data, including session state, history, branches and memories, between supported platforms.
- Transferring play data MUST remain a separate operation from distributing a game package.
- API keys and personal secrets MUST NOT be included in transferable game or play-data files.
- The exact transfer format and the handling of a missing matching game installation remain open.

## Creator Code Permissions

- All creator scripts and game UI code MUST execute with restricted permissions, including code imported as an external bundle.
- Creator code MUST NOT directly access the filesystem, network, another game's private data, host internals or the player's API keys.
- Any supported network functionality MUST be mediated through explicit, limited Helia APIs. Such functionality is not implicitly granted by this specification.
- Mediated APIs MUST NOT grant creator code the ability to perform irreversible external side effects. Authorized AI-provider requests and user-requested package or play-data transfers remain subject to their respective product requirements.
- Creator code MAY read the game state exposed to it, but writes MUST use the validated transaction interfaces.
- Bundling MUST NOT be treated as evidence that code is trusted. Imported bundles MUST follow the same API, panel-registration and sandbox rules as other creator code.
- Unsupported or unauthorized operations MUST fail without granting the requested access.
- Runtime execution SHOULD have finite resource limits and report failures without corrupting committed progress.
- Credentials MUST NOT appear in creator-visible diagnostics, logs, error messages, exported files or shared game data.

# Open Questions

The following items require product decisions. They are not permissions to bypass the requirements above.

| Area                    | Unresolved behavior                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Installation management | Repeated imports while a matching active installation exists; Trash retention and restoration behavior.                                  |
| Content changes         | Timing of an explicit apply request while an AI response or other game operation is in progress; preservation or reset of test sessions. |
| State evolution         | Whether existing event records are transformed or preserved with a compatibility mechanism.                                              |
| Hooks                   | Execution order, independent transactions, error propagation, re-entry and visible execution limits.                                     |
| AI execution            | Provider capability requirements and the structured text/JSON fallback contract.                                                         |
| Prompts and memory      | Supported RisuAI-style authoring features; the exact HypaV3 behavior being retained; retrieval and branch-spanning summary rules.        |
| Workbench               | Chat placement, panel restoration when available panels change, and layout behavior under space constraints.                             |
| Authoring               | External-bundle source management, preview/test reset behavior and advanced debugging facilities.                                        |
| Distribution            | Package and transfer formats, asset rules, validation limits, game-content compatibility and interrupted-upgrade recovery behavior.      |
| Permissions             | Any mediated external integrations and the execution limits visible to creators.                                                         |
