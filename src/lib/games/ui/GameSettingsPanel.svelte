<script lang="ts">
	import { onMount, untrack } from 'svelte';
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
	let { game, onsave }: { game: Game; onsave: (input: UpdateGameSettings) => Promise<Game> } =
		$props();
	const categories = [
		{ id: 'basic', label: '기본 설정', icon: 'game' },
		{ id: 'assets', label: '에셋', icon: 'image' },
		{ id: 'lorebook', label: '로어북', icon: 'book' },
		{ id: 'advanced', label: '고급 설정', icon: 'activity' }
	] as const;
	type Category = (typeof categories)[number]['id'];
	let category = $state<Category>('basic');
	let saved = $state.raw<UpdateGameSettings>(
		untrack(() => ({ title: game.title, ...game.settings }))
	);
	let title = $state(untrack(() => saved.title));
	let description = $state(untrack(() => saved.description));
	let firstMessage = $state(untrack(() => saved.firstMessage));
	let authorNote = $state(untrack(() => saved.authorNote));
	let saving = $state(false);
	let error = $state('');
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
		void flushSave();
	}

	function moveCategory(event: KeyboardEvent) {
		if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
		event.preventDefault();
		const index = categories.findIndex((item) => item.id === category);
		const next =
			event.key === 'Home'
				? 0
				: event.key === 'End'
					? categories.length - 1
					: (index + (event.key === 'ArrowRight' ? 1 : -1) + categories.length) % categories.length;
		category = categories[next].id;
		(event.currentTarget as HTMLElement).parentElement
			?.querySelector<HTMLButtonElement>(`[data-category="${category}"]`)
			?.focus();
	}
</script>

<svelte:window
	onpagehide={() => {
		void flushSave();
	}}
/>

<div class="settings-tabs" role="tablist" aria-label="게임 설정 분류">
	{#each categories as item (item.id)}
		<button
			id={`settings-${item.id}-tab`}
			data-category={item.id}
			class={{ active: category === item.id }}
			type="button"
			role="tab"
			aria-label={item.label}
			title={item.label}
			aria-selected={category === item.id}
			aria-controls={`settings-${item.id}-panel`}
			tabindex={category === item.id ? 0 : -1}
			onkeydown={moveCategory}
			onclick={() => (category = item.id)}><Icon name={item.icon} size={21} /></button
		>
	{/each}
</div>

<div
	id="settings-basic-panel"
	role="tabpanel"
	aria-labelledby="settings-basic-tab"
	hidden={category !== 'basic'}
	tabindex="0"
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
		<fieldset>
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
				rows="7"></textarea>
			<label for="settings-first-message">첫 메시지</label>
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
</div>

{#each categories.slice(1) as item (item.id)}
	<div
		id={`settings-${item.id}-panel`}
		role="tabpanel"
		aria-labelledby={`settings-${item.id}-tab`}
		hidden={category !== item.id}
		tabindex="0"
	></div>
{/each}

<style>
	.settings-tabs {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 6px;
		margin-bottom: 22px;
	}
	.settings-tabs button {
		display: grid;
		height: 40px;
		place-items: center;
		padding: 8px;
		border: 1px solid transparent;
		border-radius: 6px;
		background: transparent;
		color: var(--text-muted);
	}
	.settings-tabs button:hover {
		background: var(--surface-hover);
		color: var(--text-strong);
	}
	.settings-tabs button.active {
		border-color: var(--border-strong);
		background: var(--surface-active);
		color: var(--text-strong);
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
