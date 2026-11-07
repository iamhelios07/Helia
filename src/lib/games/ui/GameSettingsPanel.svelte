<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import {
		clearSettingsDraft,
		loadSettingsDraft,
		sameSettings,
		storeSettingsDraft
	} from '../settings-draft.js';
	import Icon from '#lib/components/Icon.svelte';
	import {
		GAME_TITLE_MAX_LENGTH,
		validateGameSettings,
		type Game,
		type UpdateGameSettings
	} from '../model.js';
	let {
		game,
		onsave,
		mode = 'sidebar',
		blocked = false
	}: {
		game: Game;
		onsave: (input: UpdateGameSettings) => Promise<Game>;
		mode?: 'sidebar' | 'editor';
		blocked?: boolean;
	} = $props();
	let saved = $state.raw<UpdateGameSettings>(
		untrack(() => ({ title: game.title, ...game.settings }))
	);
	let title = $state(untrack(() => saved.title));
	let description = $state(untrack(() => saved.description));
	let firstMessage = $state(untrack(() => saved.firstMessage));
	let authorNote = $state(untrack(() => saved.authorNote));
	let saving = $state(false);
	let error = $state('');
	let openingEditor = $state(false);
	const gameId = untrack(() => game.id);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let activeSave: Promise<void> | null = null;
	let composing = false;
	let changed = $derived(
		title !== saved.title ||
			description !== saved.description ||
			firstMessage !== saved.firstMessage ||
			authorNote !== saved.authorNote
	);

	onMount(() => {
		const recovered = loadSettingsDraft(gameId);
		if (recovered) {
			title = recovered.title;
			description = recovered.description;
			firstMessage = recovered.firstMessage;
			authorNote = recovered.authorNote;
			if (changed) scheduleSave();
			else clearSettingsDraft(gameId, recovered);
		}
		return () => {
			void flushSave();
		};
	});

	function currentInput(): UpdateGameSettings {
		return { title, description, firstMessage, authorNote };
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
		if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
			return;
		event.preventDefault();
		openingEditor = true;
		error = '';
		try {
			if (await flush()) await goto(resolve('/games/[id]/edit', { id: gameId }));
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
		storeSettingsDraft(gameId, currentInput());
		stopTimer();
		if (!composing)
			timer = setTimeout(() => {
				void flushSave();
			}, 350);
	}

	function flushSave(): Promise<void> {
		stopTimer();
		if (activeSave) return activeSave;
		if (!changed) {
			clearSettingsDraft(gameId, currentInput());
			return Promise.resolve();
		}
		if (composing) return Promise.resolve();
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
				const snapshot = currentInput();
				let input: UpdateGameSettings;
				try {
					input = validateGameSettings(snapshot);
				} catch (cause) {
					error = cause instanceof Error ? cause.message : '입력값을 확인해주세요.';
					return;
				}
				if (!sameSettings(input, saved)) {
					const updated = await onsave(input);
					saved = { title: updated.title, ...updated.settings };
				}
				// A completed write must never replace text entered while it was in flight.
				if (title === snapshot.title) title = saved.title;
				if (!changed) clearSettingsDraft(gameId, snapshot);
			}
		} catch {
			error = '설정을 저장하지 못했어요.';
		} finally {
			saving = false;
		}
	}

	function flushOnBlur(event: FocusEvent) {
		const form = event.currentTarget as HTMLFormElement;
		if (event.relatedTarget instanceof Node && form.contains(event.relatedTarget)) return;
		// These links await flush themselves; a blur write would retry failures on the same click.
		if (
			event.relatedTarget instanceof Element &&
			event.relatedTarget.closest('[data-settings-navigation]')
		)
			return;
		void flushSave();
	}
</script>

<svelte:window
	onpagehide={() => {
		void flushSave();
	}}
/>

{#if mode === 'sidebar'}
	<a
		class="editor-link"
		data-settings-navigation
		href={resolve('/games/[id]/edit', { id: gameId })}
		aria-disabled={openingEditor || blocked}
		onclick={openEditor}
		><Icon name="edit" size={18} />게임 편집기 열기<Icon name="arrow-right" size={16} /></a
	>
{/if}

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
	<fieldset disabled={openingEditor || (mode === 'editor' && blocked)}>
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
			bind:value={
				() => description,
				(value) => {
					description = value;
					scheduleSave();
				}
			}
			rows={mode === 'editor' ? 7 : 4}></textarea>
		{#if mode === 'editor'}<label for="settings-first-message">첫 메시지</label>
			<textarea
				id="settings-first-message"
				name="firstMessage"
				bind:value={
					() => firstMessage,
					(value) => {
						firstMessage = value;
						scheduleSave();
					}
				}
				rows="5"></textarea>
			<label for="settings-author-note">작가 노트</label>
			<textarea
				id="settings-author-note"
				name="authorNote"
				bind:value={
					() => authorNote,
					(value) => {
						authorNote = value;
						scheduleSave();
					}
				}
				rows="4"></textarea>{/if}
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
