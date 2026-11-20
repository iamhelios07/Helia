<script lang="ts">
	import type { PromptSelection } from '#lib/app/settings/prompt-selection.svelte.js';
	import type { PromptToggle } from '#lib/games/ai/prompt-toggles.js';

	import Icon from '#lib/components/Icon.svelte';

	let { selection, blocked = false }: { selection: PromptSelection; blocked?: boolean } = $props();
	function saveSwitch(input: HTMLInputElement, key: string) {
		selection.setValue(key, input.checked ? '1' : '0');
		input.checked = selection.config?.toggleValues[key] === '1';
	}
	function saveValue(
		input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
		key: string
	) {
		selection.setValue(key, input.value);
		const saved = selection.config?.toggleValues[key] ?? '';
		if (input.value !== saved) {
			input.value = saved;
		}
	}
</script>

{#snippet items(toggles: PromptToggle[])}
	{#each toggles as toggle, index (index)}
		{#if toggle.type === 'group'}
			<details open>
				<summary>{toggle.label || '그룹'}</summary>
				<div class="group">{@render items(toggle.children)}</div>
			</details>
		{:else if toggle.type === 'caption'}
			<p class="caption">{toggle.label}</p>
		{:else if toggle.type === 'divider'}
			<div class="divider">
				{#if toggle.label}<span>{toggle.label}</span>{/if}
				<hr />
			</div>
		{:else if toggle.type === 'checkbox'}
			<label class="check">
				<span>{toggle.label}</span>
				<input
					type="checkbox"
					role="switch"
					checked={selection.config?.toggleValues[toggle.key] === '1'}
					onchange={(event) => saveSwitch(event.currentTarget, toggle.key)}
				/>
			</label>
		{:else if toggle.type === 'select'}
			<label>
				<span>{toggle.label}</span>
				<select
					value={selection.config?.toggleValues[toggle.key] ?? '0'}
					onchange={(event) => saveValue(event.currentTarget, toggle.key)}
				>
					{#each toggle.options as option, optionIndex (optionIndex)}<option
							value={String(optionIndex)}>{option}</option
						>{/each}
				</select>
			</label>
		{:else if toggle.type === 'textarea'}
			<label
				><span>{toggle.label}</span><textarea
					rows="3"
					maxlength="32768"
					value={selection.config?.toggleValues[toggle.key] ?? ''}
					oninput={(event) => saveValue(event.currentTarget, toggle.key)}></textarea></label
			>
		{:else if toggle.type === 'text'}
			<label
				><span>{toggle.label}</span><input
					type="text"
					maxlength="32768"
					value={selection.config?.toggleValues[toggle.key] ?? ''}
					oninput={(event) => saveValue(event.currentTarget, toggle.key)}
				/></label
			>
		{/if}
	{/each}
{/snippet}

{#if selection.items.length || selection.error}
	<section aria-label="프리셋 토글">
		<h3><Icon name="settings" size={14} />프리셋 토글</h3>
		<p class="preset-name">{selection.name}</p>
		<fieldset disabled={blocked || !selection.config}>{@render items(selection.items)}</fieldset>
		{#if selection.error}
			<p class="error" role="alert">{selection.error}</p>
			<button type="button" onclick={selection.load}
				><Icon name="activity" size={14} />다시 불러오기</button
			>
		{/if}
	</section>
{/if}

<style>
	section {
		margin-top: 18px;
		min-width: 0;
	}
	h3 {
		display: flex;
		gap: 6px;
		align-items: center;
		margin: 0;
		color: var(--text-muted);
		font-size: 11px;
		font-weight: 500;
	}
	.preset-name,
	.caption {
		color: var(--text-muted);
		font-size: 11px;
		overflow-wrap: anywhere;
	}
	fieldset {
		display: flex;
		flex-direction: column;
		gap: 12px;
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 6px;
		color: var(--text);
		font-size: 12px;
		overflow-wrap: anywhere;
	}
	.check {
		flex-direction: row;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	input,
	select,
	textarea,
	button {
		box-sizing: border-box;
		min-width: 0;
		padding: 8px;
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		background: var(--surface);
		color: var(--text);
		font: inherit;
		font-size: 12px;
	}
	input:not([type='checkbox']),
	select,
	textarea {
		width: 100%;
	}
	input[type='checkbox'] {
		flex-shrink: 0;
		appearance: none;
		width: 32px;
		height: 18px;
		padding: 2px;
		border-radius: 12px;
		background: var(--border-strong);
		cursor: pointer;
	}
	input[type='checkbox']::before {
		content: '';
		display: block;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: var(--text);
	}
	input[type='checkbox']:checked {
		background: var(--accent);
	}
	input[type='checkbox']:checked::before {
		transform: translateX(12px);
	}
	fieldset:disabled {
		opacity: 0.6;
	}
	fieldset:disabled input {
		cursor: default;
	}
	@media (forced-colors: active) {
		input[type='checkbox'] {
			appearance: auto;
		}
		input[type='checkbox']::before {
			display: none;
		}
	}
	textarea {
		resize: vertical;
	}
	input:focus-visible,
	select:focus-visible,
	textarea:focus-visible,
	button:focus-visible,
	summary:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.group {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin-top: 12px;
		padding-left: 10px;
		border-left: 1px solid var(--border);
	}
	summary {
		cursor: pointer;
		color: var(--text);
		font-size: 12px;
		overflow-wrap: anywhere;
	}
	.divider {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--text-muted);
		font-size: 11px;
	}
	hr {
		flex: 1;
		border: 0;
		border-top: 1px solid var(--border);
	}
	.error {
		color: var(--danger, #ef9b9b);
		font-size: 12px;
	}
	button {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		cursor: pointer;
	}
</style>
