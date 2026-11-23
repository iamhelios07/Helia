<script lang="ts">
	import { tick } from 'svelte';

	import type { Game } from '../../model.js';

	import { GameVersionController } from './game-version-controller.svelte.js';
	import GameVersionConflictDialog from './GameVersionConflictDialog.svelte';

	let {
		game,
		unapplied,
		disabled = false,
		onpending
	}: {
		game: Game;
		unapplied: boolean;
		disabled?: boolean;
		onpending: (pending: boolean) => void;
	} = $props();
	const id = $props.id();
	const versioning = new GameVersionController(
		() => game,
		() => disabled,
		(pending) => onpending(pending)
	);
	let input: HTMLInputElement | undefined;
	let locked = $derived(disabled || versioning.busy || versioning.loading);

	function versionInput(element: HTMLInputElement) {
		input = element;
		return () => {
			input = undefined;
		};
	}

	async function changeVersion() {
		versioning.conflict = null;
		await tick();
		input?.focus();
		input?.select();
	}
</script>

<section class="version-panel" aria-labelledby={`${id}-heading`} aria-busy={versioning.busy}>
	<h3 id={`${id}-heading`}>배포 버전</h3>
	<div role="status">
		{#if versioning.loading}<p>버전 정보를 불러오는 중…</p>
		{:else if versioning.state}
			<p class="version-status">
				{versioning.state.currentRelease?.contentVersion ?? '미출시'}
				{#if versioning.state.modified}<span>수정됨</span>{/if}
			</p>
		{/if}
		{#if versioning.success}<p>{versioning.success}</p>{/if}
	</div>
	<p id={`${id}-help`}>
		현재 게임에 적용된 콘텐츠를 배포본으로 확정해요. 초안 저장과 적용은 배포 버전을 바꾸지 않아요.
	</p>
	{#if unapplied}<p class="draft-notice">
			미적용 초안이 있어요. 이 변경도 배포하려면 먼저 상단의 적용을 눌러주세요. 지금 확정하면 기존
			적용된 콘텐츠만 포함돼요.
		</p>{/if}
	<form
		onsubmit={(event) => {
			event.preventDefault();
			void versioning.release();
		}}
	>
		<label for={`${id}-version`}>배포 버전 (SemVer)</label>
		<div class="release-actions">
			<input
				id={`${id}-version`}
				{@attach versionInput}
				value={versioning.version}
				oninput={(event) => versioning.changeVersion(event.currentTarget.value)}
				disabled={locked || !versioning.state}
				placeholder="1.0.0"
				autocomplete="off"
				aria-describedby={`${id}-help ${id}-format`}
			/>
			<button type="submit" disabled={locked || !versioning.state}
				>{versioning.busy ? '확정 중…' : '배포본 확정'}</button
			>
		</div>
		<p id={`${id}-format`}>예: 1.0.0 / 1.1.0-beta.1</p>
	</form>
	{#if versioning.error && !versioning.conflict}<p class="error" role="alert">
			{versioning.error}
		</p>{/if}
	{#if !versioning.loading}<button type="button" disabled={locked} onclick={() => versioning.load()}
			>버전 정보 다시 불러오기</button
		>{/if}
	{#if versioning.state?.releases.length}
		<details>
			<summary>배포 이력 ({versioning.state.releases.length})</summary>
			<ul>
				{#each versioning.state.releases as release (release.id)}
					<li>
						<strong>{release.contentVersion}</strong> ·
						<time datetime={release.createdAt}
							>{new Date(release.createdAt).toLocaleString('ko-KR')}</time
						>
						<details><summary>콘텐츠 식별값</summary><code>{release.contentHash}</code></details>
					</li>
				{/each}
			</ul>
		</details>
	{/if}
</section>
{#if versioning.conflict}
	<GameVersionConflictDialog
		version={versioning.conflict.contentVersion}
		disabled={disabled || versioning.busy}
		error={versioning.error}
		onchange={changeVersion}
		onignore={() => versioning.release(true)}
		oncancel={() => {
			versioning.conflict = null;
			versioning.error = '';
		}}
	/>
{/if}

<style>
	.version-panel {
		max-width: 700px;
		margin-top: 28px;
		padding-top: 20px;
		border-top: 1px solid var(--border);
		font-size: 12px;
	}
	h3 {
		margin: 0 0 12px;
		font-size: 14px;
		color: var(--text-strong);
	}
	p {
		margin: 8px 0;
		color: var(--text-muted);
		line-height: 1.7;
	}
	.version-status {
		color: var(--text);
		font-weight: 600;
	}
	.version-status span {
		margin-left: 8px;
		color: var(--text-muted);
		font-weight: normal;
	}
	.draft-notice {
		padding: 10px;
		background: var(--surface);
		border-left: 2px solid var(--border-strong);
	}
	form {
		margin: 16px 0;
	}
	label {
		display: block;
		margin-bottom: 8px;
	}
	.release-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	input,
	button {
		min-width: 0;
		padding: 8px 10px;
		border: 1px solid var(--border-strong);
		border-radius: 4px;
		background: var(--background);
		color: var(--text);
		font: inherit;
	}
	input {
		flex: 1;
		width: 160px;
	}
	button {
		cursor: pointer;
	}
	button:disabled,
	input:disabled {
		opacity: 0.5;
		cursor: default;
	}
	button:focus-visible,
	input:focus-visible,
	summary:focus-visible {
		outline: 2px solid var(--text);
		outline-offset: 2px;
	}
	summary {
		cursor: pointer;
		color: var(--text-muted);
	}
	ul {
		padding-left: 20px;
	}
	li {
		margin: 12px 0;
		overflow-wrap: anywhere;
	}
	li details {
		margin-top: 6px;
	}
	code {
		display: block;
		margin-top: 6px;
		overflow-wrap: anywhere;
	}
	.error {
		color: var(--danger, #ef9b9b);
	}
</style>
