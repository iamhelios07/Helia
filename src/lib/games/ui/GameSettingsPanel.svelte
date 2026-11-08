<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { onMount, untrack } from 'svelte';

	import Icon from '#lib/components/Icon.svelte';

	import {
		clearMetadataDraft,
		loadMetadataDraft,
		sameMetadata,
		storeMetadataDraft,
		type MetadataDraft
	} from '../metadata-draft.js';
	import {
		GAME_TITLE_MAX_LENGTH,
		GAME_DESCRIPTION_MAX_LENGTH,
		validateGameMetadata,
		type Game,
		type GameMetadata
	} from '../model.js';
	let {
		game,
		onsave,
		blocked = false
	}: {
		game: Game;
		onsave: (input: GameMetadata) => Promise<Game>;
		blocked?: boolean;
	} = $props();
	let saved = $state.raw<MetadataDraft>(
		untrack(() => ({ title: game.title, description: game.description }))
	);
	let title = $state(untrack(() => saved.title));
	let description = $state(untrack(() => saved.description));
	let saving = $state(false);
	let error = $state('');
	let openingEditor = $state(false);
	const gameId = untrack(() => game.id);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let activeSave: Promise<void> | null = null;
	let composing = false;
	let changed = $derived(title !== saved.title || description !== saved.description);

	onMount(() => {
		const recovered = loadMetadataDraft(gameId);
		if (recovered) {
			title = recovered.title;
			description = recovered.description;
			if (changed) {
				scheduleSave();
			} else {
				clearMetadataDraft(gameId, recovered);
			}
		}
		return () => {
			void flushSave();
		};
	});

	function currentInput(): GameMetadata {
		return { title, description, genre: game.genre };
	}

	export async function flush(): Promise<boolean> {
		await flushSave();
		return !changed && !error && !composing;
	}

	async function openEditor(event: MouseEvent) {
		if (openingEditor || blocked) {
			event.preventDefault();
			return;
		}
		if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
			return;
		}
		event.preventDefault();
		openingEditor = true;
		error = '';
		try {
			if (await flush()) {
				await goto(resolve('/games/[id]/edit', { id: gameId }));
			}
		} catch {
			error = '게임 편집기를 열지 못했어요. 다시 시도해주세요.';
		} finally {
			openingEditor = false;
		}
	}

	function stopTimer() {
		clearTimeout(timer);
		timer = undefined;
	}

	function scheduleSave() {
		error = '';
		storeMetadataDraft(gameId, currentInput());
		stopTimer();
		if (!composing) {
			timer = setTimeout(() => {
				void flushSave();
			}, 350);
		}
	}

	function flushSave(): Promise<void> {
		stopTimer();
		if (activeSave) {
			return activeSave;
		}
		if (!changed) {
			clearMetadataDraft(gameId, currentInput());
			return Promise.resolve();
		}
		if (composing) {
			return Promise.resolve();
		}
		activeSave = saveChanges().finally(() => {
			activeSave = null;
		});
		return activeSave;
	}

	async function saveChanges() {
		saving = true;
		error = '';
		try {
			while (changed && !composing) {
				if (!(await saveCurrentInput())) {
					return;
				}
			}
		} catch {
			error = '설정을 저장하지 못했어요.';
		} finally {
			saving = false;
		}
	}
	async function saveCurrentInput(): Promise<boolean> {
		const snapshot = currentInput();
		let input: GameMetadata;
		try {
			input = validateGameMetadata(snapshot);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : '입력값을 확인해주세요.';
			return false;
		}
		if (!sameMetadata(input, saved)) {
			const updated = await onsave(input);
			saved = { title: updated.title, description: updated.description };
		}
		// A completed write must never replace text entered while it was in flight.
		if (title === snapshot.title) {
			title = saved.title;
		}
		if (description === snapshot.description) {
			description = saved.description;
		}
		if (!changed) {
			clearMetadataDraft(gameId, snapshot);
		}
		return true;
	}

	function flushOnBlur(event: FocusEvent) {
		const form = event.currentTarget as HTMLFormElement;
		if (event.relatedTarget instanceof Node && form.contains(event.relatedTarget)) {
			return;
		}
		// These links await flush themselves; a blur write would retry failures on the same click.
		if (
			event.relatedTarget instanceof Element &&
			event.relatedTarget.closest('[data-settings-navigation]')
		) {
			return;
		}
		void flushSave();
	}
</script>

<svelte:window
	onpagehide={() => {
		void flushSave();
	}}
/>

<a
	class="editor-link"
	data-settings-navigation
	href={resolve('/games/[id]/edit', { id: gameId })}
	aria-disabled={openingEditor || blocked}
	onclick={openEditor}
	><Icon name="edit" size={18} />게임 편집기 열기<Icon name="arrow-right" size={16} /></a
>

<form
	onsubmit={(event) => {
		event.preventDefault();
		void flushSave();
	}}
	onfocusout={flushOnBlur}
	oncompositionstart={() => {
		composing = true;
		stopTimer();
	}}
	oncompositionend={() => {
		composing = false;
		scheduleSave();
	}}
	novalidate
	aria-busy={saving}
>
	<fieldset disabled={openingEditor}>
		<label for="settings-title">이름</label>
		<input
			id="settings-title"
			name="title"
			bind:value={
				() => title,
				(value) => {
					title = value;
					scheduleSave();
				}
			}
			maxlength={GAME_TITLE_MAX_LENGTH}
			required
		/>
		<label for="settings-description">설명</label>
		<textarea
			id="settings-description"
			name="description"
			maxlength={GAME_DESCRIPTION_MAX_LENGTH}
			bind:value={
				() => description,
				(value) => {
					description = value;
					scheduleSave();
				}
			}
			rows="4"></textarea>
	</fieldset>
	{#if error}<div class="save-error">
			<p class="error" role="alert">{error}</p>
			<button
				type="button"
				onclick={() => {
					void flushSave();
				}}>다시 시도</button
			>
		</div>{/if}
</form>

<style>
	.editor-link {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		min-height: 46px;
		padding: 12px;
		margin-bottom: 24px;
		border: 1px solid var(--border-strong);
		border-radius: 8px;
		background: var(--surface-active);
		color: var(--text-strong);
		text-decoration: none;
		font-size: 13px;
		font-weight: 550;
	}
	.editor-link:hover {
		background: var(--surface-hover);
	}
	.editor-link:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.editor-link[aria-disabled='true'] {
		opacity: 0.5;
		cursor: default;
	}
	fieldset {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 10px;
		margin: 0;
		padding: 0;
		border: 0;
	}
	label {
		margin-top: 12px;
		color: var(--text-strong);
		font-size: 12px;
		font-weight: 500;
	}
	label:first-child {
		margin-top: 0;
	}
	input,
	textarea {
		width: 100%;
		min-width: 0;
		padding: 10px 11px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		background: var(--background);
		color: var(--text);
		font: inherit;
		font-size: 12px;
		line-height: 1.7;
	}
	textarea {
		min-height: 80px;
		resize: vertical;
	}
	.save-error {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin-top: 16px;
	}
	.save-error button {
		min-height: 34px;
		padding: 7px 18px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		background: var(--surface);
		color: var(--text);
		font-size: 12px;
	}
	.error {
		margin: 0;
		color: var(--text-strong);
		font-size: 12px;
		line-height: 1.7;
	}
</style>
