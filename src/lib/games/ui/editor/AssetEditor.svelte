<script lang="ts">
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';

	import { parseResources } from '../../resources.js';
	import AssetExplorer from './AssetExplorer.svelte';
	let {
		source,
		selectedId,
		disabled = false,
		onchange
	}: {
		source: string;
		selectedId?: string;
		disabled?: boolean;
		onchange: (source: string) => void;
	} = $props();
	let localSelected = $state<string | null>(null);
	let error = $state('');
	let confirming = $state(false);
	let parsed = $derived.by(() => {
		try {
			return { resources: parseResources(JSON.parse(source)), error: '' };
		} catch (cause) {
			return {
				resources: null,
				error: cause instanceof Error ? cause.message : '에셋을 읽지 못했어요.'
			};
		}
	});
	let id = $derived(selectedId ?? localSelected);
	let asset = $derived(id ? parsed.resources?.[id] : undefined);
	function rename(name: string) {
		if (!parsed.resources || !id || !asset || disabled) {
			return;
		}
		try {
			const next = parseResources({ ...parsed.resources, [id]: { ...asset, name } });
			onchange(JSON.stringify(next, null, 2));
			error = '';
		} catch (cause) {
			error = cause instanceof Error ? cause.message : '파일 이름을 수정하지 못했어요.';
		}
	}
	function remove() {
		if (!parsed.resources || !id || disabled) {
			return;
		}
		onchange(
			JSON.stringify(
				Object.fromEntries(Object.entries(parsed.resources).filter(([key]) => key !== id)),
				null,
				2
			)
		);
		confirming = false;
	}
</script>

<section class="asset-editor" aria-label="에셋 미리보기">
	{#if selectedId === undefined}
		<AssetExplorer
			{source}
			{disabled}
			{onchange}
			active={localSelected}
			onselect={(next) => (localSelected = next)}
		/>
	{/if}
	{#if parsed.error || error}<p role="alert">{error || parsed.error}</p>{/if}
	{#if asset}
		<header>
			<div>
				<h2>{asset.name.split('/').at(-1)}</h2>
				<p class="path">{asset.name}</p>
			</div>
			<button
				type="button"
				{disabled}
				aria-label={`${asset.name} 파일 삭제`}
				onclick={() => (confirming = true)}>삭제</button
			>
		</header>
		<div class="preview">
			{#if asset.mime.startsWith('image/')}<img src={asset.data} alt={asset.name} />
			{:else if asset.mime.startsWith('audio/')}<audio
					controls
					preload="none"
					src={asset.data}
					aria-label={asset.name}
				></audio>
			{:else}<video controls preload="none" src={asset.data} aria-label={asset.name}
					><track kind="captions" label="자막 없음" src="data:text/vtt,WEBVTT" /></video
				>{/if}
		</div>
		<div class="metadata">
			<label
				>파일 경로<input
					aria-label="에셋 파일 경로"
					value={asset.name}
					{disabled}
					onchange={(event) => rename(event.currentTarget.value)}
				/></label
			>
			<p>{asset.mime} · {Math.ceil((asset.data.split(',')[1].length * 0.75) / 1024)} KiB</p>
			<label
				>코드에서 사용<input
					aria-label="에셋 코드 참조"
					readonly
					value={`helia.asset(${JSON.stringify(asset.name)})`}
				/></label
			>
		</div>
	{:else if !parsed.error}<div class="empty">
			<p>
				{selectedId
					? '이 파일이 삭제되었어요.'
					: '탐색기에서 파일을 선택하면 여기에 미리보기가 표시됩니다.'}
			</p>
			<p>이미지·오디오·동영상을 추가할 수 있어요. 파일당 1 MiB, 전체 3 MiB까지 지원합니다.</p>
		</div>{/if}
</section>
{#if confirming && asset}<ConfirmDialog
		title="파일 삭제"
		message={`‘${asset.name}’ 파일을 초안에서 삭제할까요? 사용 중인 코드의 참조를 확인해주세요.`}
		{disabled}
		onconfirm={remove}
		oncancel={() => (confirming = false)}
	/>{/if}

<style>
	.asset-editor {
		min-height: 0;
		padding: 20px;
	}
	header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
	}
	h2 {
		font-size: 15px;
		margin: 0;
		overflow-wrap: anywhere;
	}
	.path {
		margin: 5px 0 16px;
		font-size: 11px;
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}
	.preview {
		min-height: 180px;
		height: clamp(180px, 35vh, 420px);
		display: flex;
		align-items: center;
		justify-content: center;
		background: #0002;
		overflow: hidden;
		border: 1px solid var(--border);
	}
	img,
	video {
		max-width: 100%;
		max-height: 100%;
		object-fit: contain;
	}
	audio {
		width: min(420px, 100%);
	}
	.metadata {
		display: grid;
		gap: 14px;
		margin-top: 20px;
		max-width: 600px;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 7px;
		font-size: 11px;
		color: var(--text-muted);
	}
	input,
	button {
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 7px 9px;
		background: var(--background);
		color: var(--text);
		font: inherit;
		min-width: 0;
	}
	button {
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	input[readonly] {
		font-family: var(--font-mono, monospace);
	}
	.metadata p,
	.empty {
		margin: 0;
		color: var(--text-muted);
		font-size: 11px;
		line-height: 1.7;
	}
	.empty {
		padding: 30px 0;
	}
	p[role='alert'] {
		color: var(--danger, #ef9b9b);
		line-height: 1.6;
	}
</style>
