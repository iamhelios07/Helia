<script lang="ts">
	import type { SettingsDialogController } from './settings-dialog-controller.svelte.js';

	let { controller }: { controller: SettingsDialogController } = $props();
	let result = $derived(controller.cleanupResult);

	function formatBytes(value: string) {
		const bytes = BigInt(value);
		const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
		let unit = 0;
		let scale = 1n;
		while (unit < units.length - 1 && bytes >= scale * 1024n) {
			scale *= 1024n;
			unit++;
		}
		const amount =
			unit === 0
				? bytes.toString()
				: (Number((bytes * 10n + scale / 2n) / scale) / 10).toLocaleString('ko-KR');
		return `${amount} ${units[unit]}`;
	}
</script>

<p class="muted">
	게임, 저장된 초안, 플레이 기록, 버전에서 쓰는 파일은 유지돼요. 브라우저 복구본에만 남은 파일은
	삭제될 수 있어요. 정리한 공간은 새 파일 저장에 다시 사용돼요.
</p>
<button
	class="primary-button"
	type="button"
	disabled={controller.cleaning}
	onclick={controller.cleanStorage}
>
	{controller.cleaning ? '정리하는 중…' : '저장 공간 정리'}
</button>
<div class="status" role="status">
	{#if controller.cleaning}
		<p>정리하는 중…</p>
	{:else if result}
		<p>
			{#if result.cleanedFiles > 0}
				파일 {result.cleanedFiles.toLocaleString('ko-KR')}개(약 {formatBytes(
					result.reclaimableBytes
				)})를 정리했어요
			{:else}
				정리할 파일이 없어요.
			{/if}
		</p>
		{#if result.skippedEditing}
			<p>편집 중인 게임 {result.skippedEditing.toLocaleString('ko-KR')}개는 건너뛰었어요</p>
		{/if}
		{#if result.skippedUnreadable}
			<p>
				데이터를 읽을 수 없는 게임 {result.skippedUnreadable.toLocaleString('ko-KR')}개는
				건너뛰었어요
			</p>
		{/if}
	{/if}
</div>
{#if controller.cleanupError}
	<p class="status" role="alert">저장 공간을 정리하지 못했어요. 다시 시도해주세요.</p>
{/if}

<style>
	.muted {
		margin: 0 0 16px;
	}
	.status {
		margin-top: 16px;
		color: var(--text);
		font-size: 13px;
		line-height: 1.7;
	}
	.status p {
		margin: 4px 0;
	}
</style>
