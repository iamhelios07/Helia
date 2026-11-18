<script lang="ts">
	import { onDestroy } from 'svelte';

	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import ItemActions from '#lib/components/ItemActions.svelte';

	import { GAME_STYLESHEET, parseCodeProject, type CodeProject } from '../../code-project.js';
	import { codeDropPath, codeFolders, renameCodePath } from './code-files.js';
	import CodeOperationDialog from './CodeOperationDialog.svelte';
	import { TreeDrag } from './tree-drag.svelte.js';
	let {
		source,
		active,
		disabled = false,
		onselect,
		onchange,
		onmove,
		onremove
	}: {
		source: string;
		active: string | null;
		disabled?: boolean;
		onselect: (path: string) => void;
		onchange: (source: string) => void;
		onmove: (before: string, after: string) => void;
		onremove: (paths: string[]) => void;
	} = $props();
	let project = $derived.by(() => {
		try {
			return parseCodeProject(JSON.parse(source));
		} catch {
			return null;
		}
	});
	let folder = $state('');
	let operation = $state<'file' | 'folder' | 'rename' | null>(null);
	let path = $state('');
	let target = $state('');
	let deleting = $state<string | null>(null);
	let disposed = false;
	onDestroy(() => {
		disposed = true;
	});
	let paths = $derived(Object.keys(project?.files ?? {}).sort());
	let folders = $derived(project ? codeFolders(project) : []);
	const drag = new TreeDrag<string>(() => ({
		disabled: disabled || operation !== null || deleting !== null,
		canDrop: (before, destination) => {
			try {
				return !!project && codeDropPath(project, before, destination) !== null;
			} catch {
				return false;
			}
		},
		ondrop: moveByDrag
	}));
	let locked = $derived(disabled || drag.busy);
	function startDrag(event: DragEvent, item: string, parent: string) {
		if (!drag.start(event, item)) {
			return;
		}
		const file = Object.hasOwn(project?.files ?? {}, item);
		folder = file ? parent : item;
		onselect(file ? item : '');
	}
	async function moveByDrag(before: string, destination: string) {
		if (!project || disabled) {
			return;
		}
		const current = project,
			original = source;
		const after = codeDropPath(current, before, destination);
		if (!after) {
			return;
		}
		const next = await renameCodePath(current, before, after);
		if (disposed) {
			return;
		}
		if (disabled || source !== original) {
			throw new Error('이동 중 코드가 변경되었어요. 최신 내용에서 다시 이동해주세요.');
		}
		write(next);
		onmove(before, after);
		folder = Object.hasOwn(current.files, before) ? destination : after;
	}
	function overFolder(event: DragEvent, destination: string) {
		if (drag.over(event, destination)) {
			(event.currentTarget as HTMLElement).closest('details')?.setAttribute('open', '');
		}
	}
	function write(next: CodeProject) {
		onchange(JSON.stringify(parseCodeProject(next), null, 2));
	}
	function begin(kind: 'file' | 'folder' | 'rename', item = '') {
		operation = kind;
		target = item;
		path = folder ? folder + '/' : '';
		if (kind === 'rename') {
			path = item.split('/').at(-1)!;
		}
	}
	function deleteReason(item: string) {
		return project && (project.entry === item || project.entry.startsWith(item + '/'))
			? '진입점이 포함되어 있어요. 다른 파일을 진입점으로 지정한 뒤 삭제하세요.'
			: '';
	}
	function remove() {
		if (!project || locked || !deleting) {
			return;
		}
		const removed = paths.filter((item) => item === deleting || item.startsWith(deleting + '/'));
		if (removed.includes(project.entry)) {
			deleting = null;
			return;
		}
		write({
			...project,
			files: Object.fromEntries(
				Object.entries(project.files).filter(([key]) => !removed.includes(key))
			),
			folders: folders.filter((item) => item !== deleting && !item.startsWith(deleting + '/'))
		});
		onremove(removed);
		folder = '';
		deleting = null;
	}
</script>

<section class="code-explorer" aria-label="코드 파일" aria-busy={drag.busy}>
	<header>
		<h2><Icon name="tool" size={13} />코드</h2>
		<div class="tools">
			<button
				type="button"
				title="새 코드 파일"
				aria-label="새 코드 파일"
				disabled={locked}
				onclick={() => begin('file')}><Icon name="plus" size={13} /></button
			>
			<button
				type="button"
				title="새 코드 폴더"
				aria-label="새 코드 폴더"
				disabled={locked}
				onclick={() => begin('folder')}><Icon name="folder" size={13} /></button
			>
		</div>
	</header>
	{#if project}
		{@render directory('')}
		{#if drag.key !== null}<div
				class={['root-drop', { 'drop-target': drag.target === '' }]}
				role="group"
				aria-label="코드 루트로 이동"
				ondragover={(event) => drag.over(event, '')}
				ondragleave={drag.leave}
				ondrop={drag.drop}
			>
				코드 루트로 이동
			</div>{/if}
		{#if drag.busy}<p class="move-status" role="status">코드를 이동하는 중…</p>{/if}
		{#if drag.error}<p class="move-status" role="alert">{drag.error}</p>{/if}
		<div class="generated" role="group" aria-label="자동 생성 파일">
			<button
				type="button"
				class={['file', { selected: active === '.helia/GameState.d.ts' }]}
				onclick={() => onselect('.helia/GameState.d.ts')}
				title="상태 스키마에서 자동 생성"
				><span class="mark">TS</span><span>GameState.d.ts</span><span class="annotation">자동</span
				></button
			>
			<button
				type="button"
				class={['file', { selected: active === '.helia/runtime.d.ts' }]}
				onclick={() => onselect('.helia/runtime.d.ts')}
				title="helia와 @helia/ui의 정의"
				><span class="mark">TS</span><span>runtime.d.ts</span><span class="annotation">자동</span
				></button
			>
		</div>
	{:else}<p role="alert">코드 프로젝트를 읽지 못했어요.</p>{/if}
</section>

{#snippet directory(parent: string)}
	{#each folders.filter((item) => item.split('/').slice(0, -1).join('/') === parent) as item (item)}
		<div class="folder-row">
			<details open>
				<summary
					class={{
						selected: folder === item,
						dragging: drag.key === item,
						'drop-target': drag.target === item
					}}
					title={item}
					draggable={!locked}
					ondragstart={(event) => startDrag(event, item, parent)}
					ondragend={drag.end}
					ondragover={(event) => overFolder(event, item)}
					ondragleave={drag.leave}
					ondrop={drag.drop}
					onclick={() => {
						folder = item;
						onselect('');
					}}><Icon name="folder" size={13} /><span>{item.split('/').at(-1)}</span></summary
				>
				<div class="children">{@render directory(item)}</div>
			</details>
			<div class="folder-actions">
				<ItemActions
					name={item}
					disabled={locked}
					onrename={() => begin('rename', item)}
					ondelete={() => {
						deleting = item;
					}}
					deleteReason={deleteReason(item)}
				/>
			</div>
		</div>
	{/each}
	{#each paths.filter((item) => item.split('/').slice(0, -1).join('/') === parent) as item (item)}
		<div class="file-row">
			<button
				type="button"
				class={['file', { selected: active === item, dragging: drag.key === item }]}
				draggable={!locked && item !== GAME_STYLESHEET}
				ondragstart={(event) => startDrag(event, item, parent)}
				ondragend={drag.end}
				ondragover={(event) => drag.over(event, parent)}
				ondragleave={drag.leave}
				ondrop={drag.drop}
				aria-current={active === item ? 'page' : undefined}
				onclick={() => {
					folder = parent;
					onselect(item);
				}}
				title={item}
				><span class="mark">{item.split('.').at(-1)?.toUpperCase()}</span><span
					>{item.split('/').at(-1)}</span
				>{#if project?.entry === item}<span class="annotation" title="프로젝트 진입점">진입점</span
					>{/if}</button
			><ItemActions
				name={item}
				disabled={locked}
				onrename={() => begin('rename', item)}
				renameReason={item === GAME_STYLESHEET ? 'style.css는 고정된 이름이에요.' : ''}
				ondelete={() => {
					deleting = item;
				}}
				deleteReason={deleteReason(item)}
				actions={project && project.entry !== item && project.files[item].language !== 'css'
					? [
							{
								id: 'set-entry',
								icon: 'arrow-right',
								text: '진입점 지정',
								onclick: () => {
									if (project) {
										write({ ...project, entry: item });
									}
								}
							}
						]
					: []}
			/>
		</div>
	{/each}
{/snippet}

{#if operation}<CodeOperationDialog
		kind={operation}
		{target}
		name={path}
		{source}
		disabled={locked}
		{onchange}
		{onmove}
		{onselect}
		onfolder={(value) => (folder = value)}
		onclose={() => (operation = null)}
	/>{/if}
{#if deleting}<ConfirmDialog
		title="코드 삭제"
		message={`‘${deleting}’${folders.includes(deleting) ? ' 폴더와 안의 파일' : ''}을 삭제할까요? 이 코드를 참조하는 파일은 수정이 필요할 수 있어요.`}
		disabled={locked}
		onconfirm={remove}
		oncancel={() => (deleting = null)}
	/>{/if}

<style>
	.code-explorer {
		padding: 9px 0;
	}
	header,
	h2,
	.tools,
	.file,
	summary {
		display: flex;
		align-items: center;
	}
	header {
		justify-content: space-between;
		padding: 0 12px 5px;
	}
	h2 {
		gap: 7px;
		margin: 0;
		font-size: 10px;
		font-weight: 500;
		color: var(--text-muted);
	}
	button {
		color: var(--text-muted);
		background: transparent;
		border: 0;
		font: inherit;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.tools button {
		display: grid;
		place-items: center;
		padding: 4px;
	}
	.file,
	summary {
		min-height: 27px;
		gap: 7px;
		width: 100%;
		text-align: left;
		padding: 3px 12px 3px 21px;
		border-radius: 0;
		cursor: pointer;
	}
	.file > span:nth-child(2),
	summary > span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.file:hover,
	summary:hover,
	.tools button:hover {
		background: var(--surface-active);
	}
	.selected {
		background: var(--surface-active);
		color: var(--text-strong);
	}
	.mark {
		color: var(--text-muted);
		font-size: 9px;
		width: 17px;
		flex-shrink: 0;
	}
	.annotation {
		margin-left: auto;
		font-size: 9px;
		white-space: nowrap;
		color: var(--text-muted);
	}
	.generated {
		margin: 5px 0 0;
		padding: 4px 0;
		border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
	}
	.children {
		margin-left: 13px;
	}
	.dragging {
		opacity: 0.4;
	}
	.drop-target {
		background: var(--surface-active);
		outline: 1px solid var(--accent);
		outline-offset: -1px;
	}
	.root-drop {
		padding: 9px 12px;
		margin: 4px 8px;
		color: var(--text-muted);
		border: 1px dashed var(--border);
		border-radius: 4px;
		font-size: 10px;
		text-align: center;
	}
	.move-status {
		padding: 6px 12px;
		overflow-wrap: anywhere;
	}
	.file-row {
		display: flex;
		align-items: center;
		padding-right: 8px;
	}
	.file-row .file {
		flex: 1;
		min-width: 0;
	}
	.folder-row {
		position: relative;
	}
	.folder-row summary {
		padding-right: 40px;
	}
	.folder-actions {
		position: absolute;
		top: 0;
		right: 8px;
	}
	summary {
		list-style: none;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	p {
		font-size: 11px;
		color: var(--text-muted);
		margin: 0;
		line-height: 1.6;
	}
</style>
