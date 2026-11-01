# AGENTS.md — Helia

## Project Overview

**Helia** is a highly customizable, open-source AI application designed specifically for immersive roleplaying games, powered by users' own API keys (BYOK).

Inspired by RisuAI, Helia takes a more specialized approach to AI-powered roleplaying.

While general-purpose roleplaying applications prioritize flexibility across different scenarios, Helia prioritizes empowering creators to build fully customized games and enabling players to enjoy them through seamless, intuitive experiences.

### Core Principles

1. **Creator Freedom** — Give creators extensive control over game mechanics, rules, interactions, and presentation without unnecessary technical constraints.
2. **Player Experience** — Hide implementation complexity from players. Games should be intuitive, responsive, and immersive.
3. **Game-First Design** — Prioritize structured, interactive gaming experiences over general-purpose chat functionality.
4. **Extensibility** — Design systems to accommodate different game genres, mechanics, and interaction patterns without requiring changes to the core application.
5. **User Ownership** — Respect users' control over their API credentials, game configurations, and saved data.
6. **Maintainability** — Prefer clear, modular, and testable implementations over clever abstractions or premature optimization.

## Technology Stack

- **Language:** TypeScript
- **Framework:** Svelte 5 and SvelteKit
- **Package Manager:** pnpm
- **Code Quality:** ESLint, Prettier
- **Testing:** Vitest
- **Additional Tools:** ai-tools

Prefer existing project dependencies and conventions. Do not introduce new dependencies unless they provide a clear benefit.

## Development Guidelines

### General

- Inspect existing implementations and project conventions before making changes.
- Prefer simple, maintainable solutions over unnecessary abstractions.
- Keep modules focused and responsibilities clearly separated.
- Avoid duplicating logic across components or systems.
- Use descriptive names and explicit types.
- Do not introduce unrelated changes or refactor working systems without justification.
- Preserve backward compatibility where reasonably possible.

### TypeScript

- Use strict TypeScript typing.
- Avoid `any` unless absolutely necessary.
- Prefer `unknown` with appropriate type narrowing when handling untrusted data.
- Define explicit types for game states, configuration objects, events, and AI interactions.
- Validate external data at runtime rather than relying solely on TypeScript types.

### Svelte and SvelteKit

- Follow Svelte 5 conventions, including runes where appropriate.
- Prefer SvelteKit-native patterns for routing, data loading, and server interactions.
- Keep business logic separate from presentation components.
- Avoid unnecessary shared state and reactive dependencies.
- Ensure interactive components remain accessible and keyboard-friendly.
- Consider performance when implementing frequently updated game interfaces.

### Game Architecture

- Keep game definitions, game execution, AI integration, persistence, and UI concerns logically separated.
- Favor data-driven game systems over hardcoded game-specific behavior.
- Allow game creators to define mechanics without modifying application internals whenever practical.
- Ensure game-state transitions are predictable and testable.
- Treat AI responses as potentially invalid or inconsistent; validate them before applying changes to authoritative game state.
- Avoid coupling core game logic to a specific AI provider, game genre, or deployment platform.
- Do not assume that every game follows a conventional chat-based interaction model.

### AI Integration

- Keep model-provider integrations modular and replaceable.
- Do not hardcode API keys, model names, or provider-specific assumptions into core game logic.
- Handle streaming responses, failures, cancellations, and provider-specific limitations gracefully.
- Preserve separation between game instructions, runtime state, and conversational context.
- Treat model-generated content as untrusted input.
- Never expose API credentials through logs, error messages, or shared game data.

### Testing and Quality

- Add or update tests when modifying meaningful application behavior.
- Prioritize tests for game rules, state transitions, serialization, and AI response handling.
- Use Vitest for unit and integration tests where appropriate.
- Run relevant checks before considering a task complete.
- Fix problems introduced by changes instead of suppressing diagnostics.

## Svelte MCP Server

You have access to the Svelte MCP server, which provides comprehensive documentation for Svelte 5 and SvelteKit.

Use the following tools when working with Svelte-related code.

### 1. list-sections

Use this tool first when investigating Svelte or SvelteKit topics.

It returns available documentation sections, including their titles, use cases, and paths.

### 2. get-documentation

After calling `list-sections`, identify all relevant documentation sections based on their descriptions and use cases.

Retrieve the relevant sections using `get-documentation` before implementing changes.

### 3. svelte-autofixer

You MUST use this tool whenever writing or modifying Svelte components.

- Analyze the resulting Svelte code.
- Address reported issues and suggestions.
- Repeat the process until no actionable issues remain.
- Do not consider a Svelte component complete without this validation when the tool is available.

### 4. playground-link

Use this tool only when the user explicitly requests a Svelte Playground link.

- Ask whether the user wants a playground link after providing standalone example code, when appropriate.
- Never generate playground links for code written directly into project files.
- Never call this tool without user confirmation.

## Agent Workflow

When implementing a feature or fixing an issue:

1. **Understand** — Inspect the relevant code and identify existing architecture and dependencies.
2. **Plan** — Determine the smallest coherent set of changes required.
3. **Verify** — Consult relevant documentation, especially through the Svelte MCP tools.
4. **Implement** — Follow established conventions while preserving modularity and extensibility.
5. **Validate** — Run appropriate tests, type checks, linting, and Svelte validation.
6. **Report** — Summarize what changed, what was verified, and any remaining limitations.

Avoid unnecessary complexity. Every new abstraction should solve an actual problem.

When architectural decisions are unclear, favor solutions that preserve creator freedom, game-system extensibility, and a seamless player experience.