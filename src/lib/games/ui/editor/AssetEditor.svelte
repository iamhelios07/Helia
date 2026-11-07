<script lang="ts">
	import { onDestroy } from 'svelte';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import { parseResources, RESOURCE_LIMITS } from '../../resources.js';
	let {
		source,
		disabled = false,
		onchange
	}: { source: string; disabled?: boolean; onchange: (source: string) => void } = $props();
	let uploading = $state(false);
	let error = $state('');
	let deleteTarget = $state<string | null>(null);
	let disposed = false;
	onDestroy(() => (disposed = true));
	let parsed = $derived.by(() => {
		try {
			return { resources: parseResources(JSON.parse(source)), error: '' };
		} catch (cause) {
			return {
				resources: null,
				error: cause instanceof Error ? cause.message : '리소스 문서 형식이 올바르지 않아요.'
			};
		}
	});
	const accepted =
		'image/png,image/jpeg,image/webp,image/gif,audio/mpeg,audio/wav,audio/ogg,video/mp4,video/webm';
	function dataURL(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () =>
				typeof reader.result === 'string'
					? resolve(reader.result)
					: reject(Error('파일을 읽지 못했어요.'));
			reader.onerror = () => reject(Error('파일을 읽지 못했어요.'));
			reader.readAsDataURL(file);
		});
	}
	async function upload(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const files = Array.from(input.files ?? []);
		input.value = '';
		if (!files.length || disabled || uploading || !parsed.resources) return;
		const previous = source;
		uploading = true;
		error = '';
		try {
			const resources = { ...parsed.resources };
			for (const file of files) {
				if (file.size > RESOURCE_LIMITS.fileBytes)
					throw Error('각 파일은 1 MiB까지 추가할 수 있어요.');
				if (!accepted.split(',').includes(file.type))
					throw Error('지원하는 이미지·오디오·동영상 파일을 선택해주세요.');
				const id = 'asset-' + crypto.randomUUID();
				resources[id] = { name: file.name, mime: file.type, data: await dataURL(file) };
			}
			const valid = parseResources(resources);
			if (disposed) return;
			if (source !== previous)
				throw Error('업로드 중 문서가 변경되었어요. 파일을 다시 선택해주세요.');
			onchange(JSON.stringify(valid, null, 2));
		} catch (cause) {
			if (!disposed) error = cause instanceof Error ? cause.message : '파일을 추가하지 못했어요.';
		} finally {
			if (!disposed) uploading = false;
		}
	}
	function rename(id: string, name: string) {
		if (!parsed.resources || disabled || uploading) return;
		const next = { ...parsed.resources, [id]: { ...parsed.resources[id], name } };
		try {
			onchange(JSON.stringify(parseResources(next), null, 2));
			error = '';
		} catch (cause) {
			error = cause instanceof Error ? cause.message : '이름을 수정하지 못했어요.';
		}
	}
	function remove() {
		if (!parsed.resources || !deleteTarget || disabled || uploading) return;
		onchange(
			JSON.stringify(
				Object.fromEntries(Object.entries(parsed.resources).filter(([id]) => id !== deleteTarget)),
				null,
				2
			)
		);
		deleteTarget = null;
	}
</script>

<section class="asset-editor" aria-label="리소스 관리" aria-busy={uploading}>
	<header>
		<h2>리소스</h2>
		<label class="upload"
			>파일 추가<input
				type="file"
				accept={accepted}
				multiple
				disabled={disabled || uploading || !parsed.resources}
				onchange={upload}
			/></label
		>
	</header>
	<p class="hint">
		이미지·오디오·동영상을 게임과 함께 저장해요. 파일당 1 MiB, 전체 3 MiB까지 지원합니다. 코드에서 <code
			>helia.asset('asset-id')</code
		>로 사용할 수 있어요.
	</p>
	{#if parsed.error}<p role="alert">{parsed.error} JSON 보기에서 원본을 수정할 수 있어요.</p>{/if}
	{#if error}<p role="alert">{error}</p>{/if}
	{#if uploading}<p role="status">파일을 추가하고 있어요.</p>{/if}
	{#if parsed.resources}
		{#if Object.keys(parsed.resources).length === 0}<p class="empty">
				추가한 리소스가 없어요.
			</p>{/if}
		<div class="assets">
			{#each Object.entries(parsed.resources) as [id, asset] (id)}
				<article>
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
					<label
						>표시 이름<input
							aria-label={`${id} 표시 이름`}
							value={asset.name}
							disabled={disabled || uploading}
							onchange={(event) => rename(id, event.currentTarget.value)}
						/></label
					>
					<code class="asset-id">{id}</code><span class="mime">{asset.mime}</span>
					<button
						type="button"
						disabled={disabled || uploading}
						aria-label={`${asset.name} 리소스 삭제`}
						onclick={() => (deleteTarget = id)}>삭제</button
					>
				</article>
			{/each}
		</div>
	{/if}
</section>
{#if deleteTarget}<ConfirmDialog
		title="리소스 삭제"
		message={`‘${parsed.resources?.[deleteTarget]?.name ?? deleteTarget}’ 리소스를 초안에서 삭제할까요? 사용 중인 코드의 참조도 확인해주세요.`}
		disabled={disabled || uploading}
		onconfirm={remove}
		oncancel={() => (deleteTarget = null)}
	/>{/if}

<style>
	.asset-editor {
		padding: 20px;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	h2 {
		font-size: 15px;
		margin: 0;
	}
	.hint {
		color: var(--text-muted);
		font-size: 11px;
		line-height: 1.7;
	}
	.upload {
		position: relative;
		overflow: hidden;
		padding: 7px 10px;
		border: 1px solid var(--border-strong);
		border-radius: 4px;
		cursor: pointer;
	}
	.upload:focus-within {
		outline: 2px solid var(--text);
		outline-offset: 2px;
	}
	.upload input {
		position: absolute;
		inset: 0;
		width: 100%;
		opacity: 0;
		cursor: pointer;
	}
	.assets {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(240px, 100%), 1fr));
		gap: 14px;
	}
	article {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 9px;
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 12px;
		min-width: 0;
	}
	.preview {
		height: 145px;
		display: flex;
		justify-content: center;
		align-items: center;
		background: #0002;
		overflow: hidden;
	}
	img,
	video {
		max-width: 100%;
		max-height: 100%;
		object-fit: contain;
	}
	audio {
		width: 100%;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 5px;
		font-size: 11px;
	}
	input,
	button {
		border: 1px solid var(--border-strong);
		border-radius: 4px;
		padding: 7px 9px;
		background: var(--surface);
		color: var(--text);
		font: inherit;
		min-width: 0;
	}
	button {
		align-self: flex-end;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.asset-id {
		font-size: 10px;
		overflow-wrap: anywhere;
		user-select: all;
	}
	.mime,
	.empty {
		color: var(--text-muted);
		font-size: 11px;
	}
	p[role='alert'] {
		color: var(--danger, #ef9b9b);
		line-height: 1.6;
	}
</style>
