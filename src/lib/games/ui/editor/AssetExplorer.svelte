<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import FileAudio from '@lucide/svelte/icons/file-audio';
	import FileImage from '@lucide/svelte/icons/file-image';
	import FileVideo from '@lucide/svelte/icons/file-video';
	import Folder from '@lucide/svelte/icons/folder';
	import FolderPlus from '@lucide/svelte/icons/folder-plus';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Upload from '@lucide/svelte/icons/upload';
	import { onDestroy } from 'svelte';

	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';

	import { parseResources, renameResourceFolder, validateResourcePath } from '../../resources.js';
	import { ACCEPTED_RESOURCES as accepted, uploadResources } from './resource-upload.js';
	let {
		source,
		active = null,
		disabled = false,
		onselect,
		onchange
	}: {
		source: string;
		active?: string | null;
		disabled?: boolean;
		onselect: (id: string) => void;
		onchange: (source: string) => void;
	} = $props();
	let error = $state('');
	let uploading = $state(false);
	let destination = $state('');
	let collapsed = $state<string[]>([]);
	let emptyFolders = $state<string[]>([]);
	let folderForm = $state<'create' | 'rename' | null>(null);
	let folderName = $state('');
	let deleteFolder = $state<string | null>(null);
	let disposed = false;
	onDestroy(() => {
		disposed = true;
	});
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
	let folders = $derived.by(() => {
		const paths = [...emptyFolders];
		for (const path of [
			...emptyFolders.map((path) => path + '/'),
			...Object.values(parsed.resources ?? {}).map((asset) => asset.name)
		]) {
			const parts = path.split('/');
			for (let i = 1; i < parts.length; i++) {
				const parent = parts.slice(0, i).join('/');
				if (!paths.includes(parent)) {
					paths.push(parent);
				}
			}
		}
		return paths.sort();
	});
	let rows = $derived.by(() => {
		const all: { path: string; id: string | null; depth: number; folder: boolean; mime: string }[] =
			[
				...folders.map((path) => ({
					path,
					id: null,
					depth: path.split('/').length - 1,
					folder: true,
					mime: ''
				})),
				...Object.entries(parsed.resources ?? {}).map(([id, asset]) => ({
					path: asset.name,
					id,
					depth: asset.name.split('/').length - 1,
					folder: false,
					mime: asset.mime
				}))
			];
		return all
			.sort((a, b) => {
				const left = a.path.split('/');
				const right = b.path.split('/');
				for (let i = 0; i < Math.min(left.length, right.length); i++) {
					if (left[i] !== right[i]) {
						const af = i < left.length - 1 || a.folder;
						const bf = i < right.length - 1 || b.folder;
						if (af !== bf) {
							return af ? -1 : 1;
						}
						return left[i].localeCompare(right[i]);
					}
				}
				return left.length - right.length;
			})
			.filter((row) => !collapsed.some((path) => row.path.startsWith(path + '/')));
	});
	function toggle(path: string) {
		destination = path;
		collapsed = collapsed.includes(path)
			? collapsed.filter((item) => item !== path)
			: [...collapsed, path];
	}
	function applyFolder() {
		if (disabled || !parsed.resources) {
			return;
		}
		try {
			validateResourcePath(folderName);
			if (
				folders.includes(folderName) ||
				Object.values(parsed.resources).some(
					(asset) => asset.name === folderName || folderName.startsWith(asset.name + '/')
				)
			) {
				throw Error('같은 경로가 이미 있어요.');
			}
			if (folderForm === 'rename') {
				onchange(
					JSON.stringify(renameResourceFolder(parsed.resources, destination, folderName), null, 2)
				);
				emptyFolders = emptyFolders.map((path) =>
					path === destination || path.startsWith(destination + '/')
						? folderName + path.slice(destination.length)
						: path
				);
			} else {
				emptyFolders = [...emptyFolders, folderName];
			}
			destination = folderName;
			collapsed = collapsed.filter((path) => path !== folderName);
			folderForm = null;
			error = '';
		} catch (cause) {
			error = cause instanceof Error ? cause.message : '폴더를 수정하지 못했어요.';
		}
	}
	function removeFolder() {
		if (!deleteFolder || !parsed.resources || disabled) {
			return;
		}
		const path = deleteFolder;
		onchange(
			JSON.stringify(
				Object.fromEntries(
					Object.entries(parsed.resources).filter(([, asset]) => !asset.name.startsWith(path + '/'))
				),
				null,
				2
			)
		);
		emptyFolders = emptyFolders.filter((item) => item !== path && !item.startsWith(path + '/'));
		destination = '';
		deleteFolder = null;
	}
	async function upload(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const files = Array.from(input.files ?? []);
		input.value = '';
		if (!files.length || disabled || uploading || !parsed.resources) {
			return;
		}
		const previous = source;
		const target = folders.includes(destination) ? destination : '';
		uploading = true;
		error = '';
		try {
			const { resources: valid, first } = await uploadResources(files, parsed.resources, target);
			if (disposed) {
				return;
			}
			if (source !== previous || disabled) {
				throw Error('업로드 중 내용이 변경되었어요. 파일을 다시 선택해주세요.');
			}
			onchange(JSON.stringify(valid, null, 2));
			collapsed = collapsed.filter((path) => !target.startsWith(path));
			onselect(first);
		} catch (cause) {
			if (!disposed) {
				error = cause instanceof Error ? cause.message : '파일을 추가하지 못했어요.';
			}
		} finally {
			if (!disposed) {
				uploading = false;
			}
		}
	}
</script>

<section class="asset-explorer" aria-label="에셋 탐색기" aria-busy={uploading}>
	<header>
		<h2>에셋</h2>
		<div class="tools">
			<button
				type="button"
				aria-label="새 에셋 폴더"
				title="새 폴더"
				disabled={disabled || uploading || !parsed.resources}
				onclick={() => {
					folderForm = 'create';
					folderName = destination ? destination + '/' : '';
				}}><FolderPlus size={14} /></button
			>
			<label class="upload" title="파일 추가"
				><Upload size={14} /><input
					aria-label="파일 추가"
					type="file"
					accept={accepted}
					multiple
					disabled={disabled || uploading || !parsed.resources}
					onchange={upload}
				/></label
			>
		</div>
	</header>
	{#if parsed.error || error}<p role="alert">{error || parsed.error}</p>{/if}
	{#if uploading}<p role="status">파일 추가 중…</p>{/if}
	{#if folderForm}<form
			onsubmit={(event) => {
				event.preventDefault();
				applyFolder();
			}}
		>
			<input
				aria-label="폴더 경로"
				bind:value={folderName}
				placeholder="images/characters"
				{disabled}
			/>
			<div class="form-actions">
				<button type="submit" {disabled}>확인</button><button
					type="button"
					onclick={() => (folderForm = null)}>취소</button
				>
			</div>
		</form>{/if}
	<nav aria-label="에셋 파일">
		{#each rows as row (row.folder ? 'folder:' + row.path : row.id)}
			<button
				type="button"
				class={['entry', { selected: row.folder ? destination === row.path : active === row.id }]}
				style:--depth={row.depth}
				title={row.path}
				aria-label={row.folder ? `${row.path} 폴더` : row.path}
				aria-expanded={row.folder ? !collapsed.includes(row.path) : undefined}
				aria-current={!row.folder && active === row.id ? 'page' : undefined}
				onclick={() => (row.folder ? toggle(row.path) : onselect(row.id!))}
			>
				{#if row.folder}{#if collapsed.includes(row.path)}<ChevronRight
							size={12}
						/>{:else}<ChevronDown size={12} />{/if}<Folder size={14} />{:else}<span class="indent"
					></span>{#if row.mime.startsWith('image/')}<FileImage
							size={14}
						/>{:else if row.mime.startsWith('audio/')}<FileAudio size={14} />{:else}<FileVideo
							size={14}
						/>{/if}{/if}
				<span class="filename">{row.path.split('/').at(-1)}</span>
			</button>
		{:else}<p class="empty">파일을 추가해보세요.</p>{/each}
	</nav>
	{#if folders.includes(destination)}<div class="folder-actions">
			<span title={destination}>{destination}/</span><button
				type="button"
				aria-label="에셋 폴더 이름 변경"
				title="폴더 이름 변경"
				disabled={disabled || uploading}
				onclick={() => {
					folderForm = 'rename';
					folderName = destination;
				}}><Pencil size={12} /></button
			><button
				type="button"
				aria-label="에셋 폴더 삭제"
				title="폴더 삭제"
				disabled={disabled || uploading}
				onclick={() => (deleteFolder = destination)}><Trash2 size={12} /></button
			><button
				type="button"
				aria-label="에셋 루트 선택"
				title="루트에 파일 추가"
				onclick={() => (destination = '')}>/</button
			>
		</div>{/if}
</section>
{#if deleteFolder}<ConfirmDialog
		title="폴더 삭제"
		message={`‘${deleteFolder}’ 폴더와 안의 파일을 삭제할까요? 사용 중인 코드의 참조를 확인해주세요.`}
		disabled={disabled || uploading}
		onconfirm={removeFolder}
		oncancel={() => (deleteFolder = null)}
	/>{/if}

<style>
	.asset-explorer {
		min-width: 0;
	}
	header,
	.tools,
	.form-actions,
	.folder-actions {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	header {
		justify-content: space-between;
		padding: 10px 12px 6px;
	}
	h2 {
		font-size: 11px;
		font-weight: 600;
		margin: 0;
		color: var(--text-muted);
	}
	button,
	input {
		font: inherit;
		color: var(--text);
	}
	button {
		border: 0;
		background: transparent;
		cursor: pointer;
	}
	.tools button,
	.upload,
	.folder-actions button {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border-radius: 3px;
	}
	button:hover,
	.upload:hover {
		background: var(--surface-hover, #ffffff0c);
	}
	button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.upload {
		position: relative;
		overflow: hidden;
		cursor: pointer;
	}
	.upload:focus-within {
		outline: 1px solid var(--text);
	}
	.upload input {
		position: absolute;
		inset: 0;
		width: 100%;
		opacity: 0;
		cursor: pointer;
	}
	.entry {
		display: flex;
		align-items: center;
		gap: 5px;
		width: 100%;
		padding: 5px 10px 5px calc(10px + var(--depth) * 12px);
		text-align: left;
		font-size: 11px;
	}
	.entry.selected {
		background: var(--surface-selected, #ffffff14);
	}
	.filename {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.indent {
		width: 12px;
		flex-shrink: 0;
	}
	.entry :global(svg) {
		flex-shrink: 0;
		color: var(--text-muted);
	}
	p {
		margin: 6px 12px;
		font-size: 11px;
		line-height: 1.5;
		color: var(--text-muted);
	}
	p[role='alert'] {
		color: var(--danger, #ef9b9b);
		overflow-wrap: anywhere;
	}
	form {
		padding: 6px 12px;
	}
	form input {
		width: 100%;
		min-width: 0;
		padding: 6px;
		border: 1px solid var(--border);
		border-radius: 3px;
		background: var(--background);
	}
	.form-actions {
		justify-content: flex-end;
		margin-top: 4px;
	}
	.form-actions button {
		padding: 4px;
	}
	.folder-actions {
		margin: 6px 8px;
		color: var(--text-muted);
	}
	.folder-actions span {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		font-size: 10px;
		white-space: nowrap;
	}
</style>
