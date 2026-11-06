# Helia

Helia lets creators define a game's content, rules and presentation, and lets players play using their own AI connections. This glossary defines the shared language of the product and codebase; an entry does not imply that its feature is implemented.

Definitions follow the [product specification](./docs/SPEC.md), [game and session models](./src/lib/games/model.ts), [state and history models](./src/lib/games/state/model.ts), [execution guide](./src/lib/storage/README.md), [game UI guide](./src/lib/games/ui/README.md), [AI settings guide](./src/lib/app/settings/README.md) and decisions agreed during design discussions. General programming terminology and library usage are outside this glossary's scope.

## Language

### Games and Identity

**Creator**:
A person who defines a game's content, rules, prompts, UI and interactions. A player may also author changes to an unlocked installation.

**Player**:
A person who installs a game and plays its sessions. The player chooses the AI provider, model and Prompt Preset.

**Game**:
The creator-owned content and rules that define an independently playable experience. A Game is distinct from a particular installation or playthrough.
_Avoid_: Using Game as a synonym for a distribution file or Session.

**Game Package**:
A distributable file containing a game's content, rules, prompts, UI and required resources. Personal API credentials and play history are not part of a Game Package.

**Installation**:
An independently identified local copy of a game, created directly or imported from a Game Package. Multiple installations of the same original game can own separate sessions.

**Original Game Identifier**:
The identity that identifies the original game from which an installation derives. It is separate from the Installation Identifier and Content Version.

**Installation Identifier**:
The identity of an individual installation, used in its game-screen route. Separate installations of the same original game have different identifiers.

**Content Version**:
The SemVer version of the game content released by its creator. It is separate from Helia's internal storage format version and Session Revision.

**Library**:
The application area for listing, searching, sorting and opening installed games.

**Game Metadata**:
Information used to identify and present a game in the Library, such as its title, genre and public description. It is separate from instructions supplied to the AI.

**Session**:
An independent playthrough of one installation, with its own game state, conversation, history, branches and memories. Sessions of the same game do not share progress.
_Avoid_: Calling an installation or the chat panel itself a Session.

### Game State and Content

**Game State**:
Structured, persistent facts about a session's game world. It is authoritative for structured facts and does not change through AI narration or presentation alone.
_Avoid_: Treating UI State, prompts or Memory as Game State.

**Initial State**:
The creator-defined game state from which a new session begins. It satisfies the game's Schema and is distinct from the state reached during play.

**Schema**:
A declaration of the permitted structure, fields and types of Game State. It is distinct from a Filter, which evaluates game rules involving those values.

**State Document**:
The authoring source that contains a game's Schema and Initial State as separate fields. Visual editing and source editing refer to this same definition.

**State Change**:
A record of how a value at a particular game-state path changed. It distinguishes additions, removals and modifications and supports restoration of recorded outcomes.

**State Proposal**:
A candidate next game state that has not yet committed. It is not authoritative Game State before passing the applicable Schema, Filter and other execution checks.

**Atomic Workspace**:
The temporary area in which one atomic operation accumulates uncommitted state changes. Later steps in that operation can read the accumulated state, but it is not committed state until the whole operation succeeds.
_Avoid_: Confusing it with the Workbench or Game Workspace, which are UI concepts.

**Committed State**:
The game state established as authoritative session progress by a successful Transaction. It is distinct from temporary workspace state and streamed narration.

**Session Progress**:
The selected history position together with its game state, content snapshot and revision. It means more than Game State alone.

**Session Revision**:
A monotonically increasing value identifying changes to session progress. It changes on history selection as well as state commits, so it is neither a Content Version nor the depth of the selected history event.

**Game Content Snapshot**:
A consistent copy of the schema, initial state, scripts, game settings, lorebook and UI used as the basis for a session's execution. Player-owned Prompt Presets are separate from this content.
_Avoid_: Confusing it with a checkpoint of Game State reached during play.

**State Checkpoint**:
A copy of Game State at a particular history position that can serve as a starting point for later restoration. It is separate from a Game Content Snapshot, which contains game rules and content.
_Avoid_: Using Snapshot alone without distinguishing these two meanings.

### Creator Logic and Execution

**Creator Script**:
Code defining creator logic such as Actions, Queries, Filters and Hooks. It has a different role from Game UI code, but both are creator code with restricted permissions.

**Action**:
A creator-defined game operation identified by its name and arguments, independent of whether UI, AI or a Hook invokes it. Its state changes follow the validation and commit boundary of a Transaction.
_Avoid_: Assuming that every Action invocation creates a separate Transaction or branch.

**Query**:
A creator-defined operation that reads game state and arguments and returns only lookup or calculation results. It cannot modify Game State, create a Transaction or emit UI Events; within an Agent Loop, it reads temporary state accumulated by earlier tools.
_Avoid_: Treating it as having the same execution contract as an Action that happens to leave state unchanged.

**Filter**:
A creator-defined rule that accepts or rejects the state changes proposed by a Transaction. It does not silently modify a proposal to make it acceptable.

**Hook**:
Creator-defined logic that reacts to state changes or events with follow-up work. Its commit and failure boundaries depend on whether it is included in the originating operation or runs independently.

**Included Hook**:
A Hook that runs within the originating operation's atomic scope. Failure of its included work prevents that entire scope from committing, and intermediate steps are not separate branch points.

**Independent Hook**:
A Hook that runs in a separate Transaction scope after the originating Transaction succeeds. Its failure does not undo the original commit, and it cannot serve as a way to commit otherwise uncommitted Agent Loop state.

**Hook Chain**:
A sequence in which follow-up Actions from a Hook trigger further Hooks. Each Hook retains its included or independent boundary throughout the chain.

**Transaction**:
An atomic unit that commits validated game-state changes and associated records together, or commits none of them. It can include multiple Actions and Included Hooks, and can also represent message history without state changes.
_Avoid_: Automatically equating a game Transaction with one Tool Call or an internal database transaction.

**Transaction Summary**:
A human-readable explanation of a transaction record. A creator-provided description takes precedence; otherwise, the summary is generated from recorded changes using rules.

### Conversation and History

**Message**:
User-role or assistant-role text presented in a session's conversation, independent of whether state changes occur. A Message committed with a Transaction shares that Transaction's history boundary.

**Opening Message**:
Creator-authored conversation content provided at the start of a new session. It belongs to the initial session boundary and is distinct from a response generated during play.

**History Event**:
One committed history unit at which conversation and Game State can be restored consistently. A Transaction and Message committed together form one navigable and deletable Event, while either a message or state changes may be absent.
_Avoid_: Calling a UI Event or uncommitted Tool Call a History Event.

**Session History**:
The complete record of a session's committed Events and their predecessor relationships. It includes preserved futures outside the currently selected path.

**Branch**:
A continuation of history that shares an earlier past with another continuation but follows a different future. Continuing from a past Event creates a Branch while preserving the previous future.

**Branch Point**:
A committed history boundary from which different continuations can be created. Intermediate Actions and Tool Calls within one atomic operation are not Branch Points.

**Selected Head**:
The currently selected Event that determines the conversation and restored state shown for a session. No selected Event represents the initial state.

**Active Path**:
The committed history path from the session's initial boundary to its Selected Head. It determines the current conversation and which memories are valid on that path.

**History Checkout**:
The operation of selecting an existing Event or the initial boundary and moving to its conversation, state and valid memories. It does not itself delete an existing future or create a new Branch.
_Avoid_: Using deletion or undo as synonyms.

**History Restoration**:
Reconstruction of a selected history position's game state and conversation from recorded outcomes. It does not rerun AI, Hooks or random decisions to produce new outcomes.

**History Deletion**:
Removal of a selected Event, all its descendants and their associated data. It preserves preceding history shared by surviving paths and is distinct from History Checkout.

### AI Connections and Prompts

**BYOK (Bring Your Own Key)**:
The usage model in which players register their own AI credentials and choose a provider and model. It is distinct from distributing a creator's shared key with game content.

**API Connection**:
A player-registered AI service connection identifying an API format, endpoint and the credentials bound to that connection. Multiple Model Entries can use one API Connection.

**Provider**:
A service offering access to AI models. The service's identity and the API Format used to communicate with it are separate concepts.
_Avoid_: Inferring API Format or model capabilities solely from the provider's name.

**API Format**:
The communication contract for AI requests, responses, streaming and tool calls. One provider may offer multiple formats, and different providers may support the same compatible format.

**Model Entry**:
A player-named model selection that references an API Connection and a provider-facing model ID. Multiple entries can use the same model ID under different names.

**Default Model**:
The registered Model Entry selected by the player as the default choice. It is distinct from a model imposed by creator-authored game content.

**Creator Prompt**:
Creator-authored instructions defining the AI's role and how it should conduct the game. It is separate from the public game description, current Game State and conversation history.

**Prompt Block**:
An individual unit within a Prompt Preset, with settings such as type, special type, role and content. Multiple blocks arrange player instructions and game content into the context supplied to the model.

**Prompt Preset**:
A player-owned, application-wide definition of prompt blocks, ordering, reusable instructions and response options. It is separate from a game's creator-authored instructions and lorebook and is not part of a Game Package or Game Content Snapshot.

**Selected Prompt Preset**:
The Prompt Preset chosen by the player for subsequent AI Invocations across games. An invocation retains the preset captured when it starts, independently of later selection or edits.

**Prompt Role**:
The conversational role under which a prompt item is supplied to the model. It is distinct from an in-game role such as the AI acting as a game master or NPC.

**Author's Note**:
Additional AI instructions written by the creator in the game's settings. It is separate from the public Library description and Opening Message.

**Lorebook**:
Creator-authored entries of world, character and setting knowledge used in prompts. It is distinct from Memory derived from play history.

**AI Context**:
The information supplied to an AI invocation, including creator prompts, conversation on the selected path, committed change records, valid memories and current state. Committed UI-driven operations are reflected through Game State and change records.

**Current-State Summary**:
A representation of current structured game-world facts placed at the bottom of the assembled AI Context. It is distinct from long-term narrative Memory and Transaction Summaries.

### AI Execution and Tools

**Tool**:
A creator-authorized Action or Query exposed to the AI with a name, description and argument contract. Registering a creator operation does not automatically expose it as a Tool.

**Tool Call**:
A step in which the AI requests execution of a particular Tool with selected arguments. It does not by itself represent a committed state change or separate History Event.

**Tool Result**:
Return data or failure information from a Tool supplied to a subsequent model response. It is separate from the Final Answer shown to the player, and sensitive result values are hidden in the UI by default.

**Agent Loop**:
One AI request that repeats model responses and tool calls within a single atomic scope of game-state changes. Temporary changes commit only after successful receipt or streaming of the Final Answer and successful final validation and conflict checks.
_Avoid_: Using it as a synonym for one model API request or an individual Tool Call.

**AI Invocation**:
An explicit request to start AI execution from player input or creator-configured APIs or component events. Ordinary UI interactions and Action execution do not automatically invoke AI.

**Internal Event**:
Input that the creator chooses to send to the AI without creating a visible player Message. It is separate from a committed History Event and a presentation-oriented UI Event.

**Final Answer**:
The final narrative response presented to the player after the Agent Loop's work, including any tool execution. Text still being received does not establish that the associated game-state changes have committed.

**Thinking**:
Thinking-related text supplied separately by the AI provider during a response. It does not mean a summary generated by an additional Helia call or a tool-progress indicator.

**Incomplete Attempt**:
An AI execution attempt that did not become a successfully committed response and associated state changes because of interruption, failure, cancellation or a failed commit. Any partially displayed text remains distinct from a successful answer or committed progress.

### Memory

**Memory**:
Narrative information derived from conversation or committed game events. It may include promises, relationships and secrets absent from structured state, but does not override structured facts in Game State.

**Memory Source**:
The conversation or committed game events from which a Memory was derived. These sources determine its validity and the effects of history deletion.

**Branch-Valid Memory**:
A Memory whose required sources are all valid on the currently selected history path. It excludes information originating only in a different future, while memories of a shared past can be reused across branches.

**HypaV3**:
The memory system whose established generation, management and trigger behavior Helia's long-term memory is intended to retain and extend. Storing Memory records or filtering them by source alone does not constitute HypaV3.

### Game Screens and Layout

**Game Workspace**:
The game screen for opening an installation and session to play, manage sessions, edit settings and inspect history. It is separate from an Atomic Workspace used for state calculations.

**Workbench**:
The area within the Game Workspace where Chat and creator Panels are arranged, moved, split and resized together. It is separate from application-wide navigation and sidebar controls.

**Game UI**:
Creator-defined presentation and interaction content for a game. It can request game operations and subscribe to state, but cannot directly mutate authoritative Game State.

**Panel**:
A registered unit of Game UI that can be placed independently in the Workbench. One Game UI can provide multiple Panels.

**Chat**:
The Helia-owned view for session conversation, AI responses, message input, streaming and related history operations. Creators can customize its appearance, while the host manages its structural behavior and permissions.

**Default Layout**:
The initial Panel arrangement supplied by the creator for a game. It is distinct from the arrangement edited and saved by the player.

**Player Layout**:
The per-game arrangement saved by the player, including Chat and Panel positions, split ratios and minimization. It is restored after restarting the application and is separate from Game State and transient UI State.

**Panel Minimization**:
A state in which a Panel is hidden while its registration and saved layout position remain intact. It is distinct from unregistering or permanently deleting a Panel.

**UI State**:
Transient presentation state, such as selected tabs, scroll positions and open dialogs, rather than facts about the game world. It is separate from Game State, Transactions, branching history and the Player Layout retained across restarts.

**State Subscription**:
A relationship through which a view reads the current session's committed Game State and receives subsequent updates. It is distinct from a UI Event representing a one-time notification or effect.

**UI Event**:
An event delivering a one-time presentation effect, such as a notification or screen shake. Transaction-dependent events are delivered only after the corresponding commit; they are not persistent History Events replayed during restoration.
_Avoid_: Confusing it with a History Event or AI-directed Internal Event.

### Authoring, Distribution and Permissions

**Authoring Draft**:
Saved creator edits that have not yet been applied to running content. Saving a draft and applying it are separate operations.

**Applied Content**:
Creator content that has passed validation and explicit Apply and serves as the basis for game execution. It need not match the latest saved Authoring Draft.

**Apply**:
The explicit operation of validating saved Authoring Draft edits and making them available to game execution. It is distinct from saving edits or rewriting previously committed game outcomes.

**Live Preview**:
An authoring view for inspecting the behavior and presentation of scripts and UI under development. It is distinct from a Test Session with its own play progress.

**Test Session**:
A separate playthrough used by a creator to test a game. It is distinct from ordinary play progress and from a presentation-only preview.

**External Bundle**:
Game content whose code and required dependencies were prepared together in an external development environment. It follows the same permissions and execution boundaries as in-app creator code; bundling does not establish trust or grant additional permissions.

**Game Asset**:
A creator resource, such as an image, referenced by game content or UI and distributed with the game. It is distinct from machine-specific absolute paths and personal Play Data.

**Editing Lock**:
An editing restriction that protects a distributed installation from accidental modification. Unlocking it does not expand the runtime permissions of creator code.

**Upgrade**:
Replacement of an existing installation with a new Content Version after required content and state validation and transformation. It is distinct from installing a separate copy, which preserves the existing installation and receives a new identifier.

**Game-Content Migration**:
Validation and transformation of current and historical branch states to accommodate changes to a game's schema, initial state or rules. It is separate from changes to Helia's internal storage format.

**Play Data**:
Personal progress needed to resume play, including session state, history, branches and memories. It is separate from a Game Package distributed by a creator.

**Play-Data Transfer**:
An explicit file export and import that moves game state, history, branches and memories between supported environments. It is separate from game distribution and automatic synchronization and excludes API credentials.

**Trash**:
The area retaining a deleted installation and its sessions together outside active use. It does not imply a recovery guarantee for individually deleted History Events.

**Trusted Host**:
The Helia execution authority that manages game persistence, validation, permissions and AI credential access. Its secrets and privileges are not directly exposed to Creator Scripts or Game UI.

**Creator Sandbox**:
The execution boundary separating creator code from the host and limiting it to permitted game APIs. External Bundles follow the same boundary, independently of Editing Lock status.
