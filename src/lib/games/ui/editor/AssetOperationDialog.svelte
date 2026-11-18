<script lang="ts">
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import NameDialog from '#lib/components/NameDialog.svelte';

	import { parseResources, renameResourceFolder, type GameResources } from '../../resources.js';
	let {
		operation,
		resources,
		folders,
		disabled,
		onchange,
		onrename,
		onremove,
		onclose
	}: {
		operation: { kind: 'rename' | 'delete'; path: string; id: string | null };
		resources: GameResources;
		folders: string[];
		disabled: boolean;
		onchange: (value: string) => void;
		onrename: (before: string, after: string) => void;
		onremove: (ids: string[], path: string) => void;
		onclose: () => void;
	} = $props();
	function rename(value: string) {
		if (disabled) {
			throw Error('지금은 에셋을 수정할 수 없어요.');
		}
		if (/[/\\]/.test(value)) {
			throw Error('이름에는 /를 사용할 수 없어요.');
		}
		const { path, id } = operation;
		const parent = path.split('/').slice(0, -1);
		const after = [...parent, value].join('/');
		if (after === path) {
			return;
		}
		if (folders.includes(after)) {
			throw Error('같은 경로가 이미 있어요.');
		}
		let next: GameResources;
		if (id) {
			if (!resources[id]) {
				throw Error('이 파일이 삭제되었어요.');
			}
			next = parseResources({ ...resources, [id]: { ...resources[id], name: after } });
		} else {
			if (Object.values(resources).some((asset) => asset.name === after)) {
				throw Error('같은 경로가 이미 있어요.');
			}
			next = renameResourceFolder(resources, path, after);
		}
		onrename(path, after);
		onchange(JSON.stringify(next, null, 2));
	}
	function remove() {
		if (disabled) {
			return;
		}
		const { path, id } = operation;
		const ids = Object.keys(resources).filter((key) =>
			id ? key === id : resources[key].name.startsWith(path + '/')
		);
		onchange(
			JSON.stringify(
				Object.fromEntries(Object.entries(resources).filter(([key]) => !ids.includes(key))),
				null,
				2
			)
		);
		onremove(ids, path);
		onclose();
	}
</script>

{#if operation.kind === 'rename'}
	<NameDialog
		name={operation.path.split('/').at(-1)!}
		description={operation.path}
		{disabled}
		onconfirm={rename}
		oncancel={onclose}
	/>
{:else}
	<ConfirmDialog
		title={operation.id ? '파일 삭제' : '폴더 삭제'}
		message={`‘${operation.path}’${operation.id ? ' 파일' : ' 폴더와 안의 파일'}을 삭제할까요? 사용 중인 코드의 참조를 확인해주세요.`}
		{disabled}
		onconfirm={remove}
		oncancel={onclose}
	/>
{/if}
