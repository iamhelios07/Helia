<script lang="ts">
	import { onDestroy } from 'svelte';

	import NameDialog from '#lib/components/NameDialog.svelte';

	import { parseCodeProject, type CodeProject } from '../../code-project.js';
	import { cleanProjectPath, codeFolders, codeLanguage, renameCodePath } from './code-files.js';
	let {
		kind,
		target,
		name,
		source,
		disabled,
		onchange,
		onmove,
		onselect,
		onfolder,
		onclose
	}: {
		kind: 'file' | 'folder' | 'rename';
		target: string;
		name: string;
		source: string;
		disabled: boolean;
		onchange: (source: string) => void;
		onmove: (before: string, after: string) => void;
		onselect: (path: string) => void;
		onfolder: (path: string) => void;
		onclose: () => void;
	} = $props();
	let disposed = false;
	onDestroy(() => {
		disposed = true;
	});
	let title = $derived(kind === 'folder' ? '새 코드 폴더' : '새 코드 파일');
	async function rename(project: CodeProject, after: string) {
		const original = source;
		const file = Object.hasOwn(project.files, target);
		const next = await renameCodePath(project, target, after);
		if (disposed) {
			return;
		}
		if (disabled || source !== original) {
			throw Error('변경 중 코드가 수정되었어요. 다시 시도해주세요.');
		}
		onchange(JSON.stringify(next, null, 2));
		onmove(target, after);
		onfolder(file ? after.split('/').slice(0, -1).join('/') : after);
	}
	function nextPath(value: string) {
		if (kind !== 'rename') {
			return cleanProjectPath(value);
		}
		if (/[/\\]/.test(value)) {
			throw Error('이름에는 /를 사용할 수 없어요. 이동할 때는 드래그해주세요.');
		}
		return cleanProjectPath([...target.split('/').slice(0, -1), value].join('/'));
	}
	async function submit(value: string) {
		if (disabled) {
			throw Error('지금은 코드를 수정할 수 없어요.');
		}
		const project = parseCodeProject(JSON.parse(source));
		const path = nextPath(value);
		if (kind === 'rename') {
			await rename(project, path);
			return;
		}
		const folders = codeFolders(project);
		if (Object.hasOwn(project.files, path) || folders.includes(path)) {
			throw Error('같은 경로가 이미 있어요.');
		}
		if (kind === 'folder') {
			onchange(
				JSON.stringify(parseCodeProject({ ...project, folders: [...folders, path] }), null, 2)
			);
			onfolder(path);
			return;
		}
		onchange(
			JSON.stringify(
				parseCodeProject({
					...project,
					files: { ...project.files, [path]: { language: codeLanguage(path), source: '' } }
				}),
				null,
				2
			)
		);
		onselect(path);
	}
</script>

<NameDialog
	title={kind === 'rename' ? '이름 변경' : title}
	{name}
	label={kind === 'rename' ? '이름' : '프로젝트 상대 경로'}
	description={kind === 'rename'
		? `${target}\n연결된 import도 함께 갱신합니다.`
		: '폴더는 /로 구분해요.'}
	{disabled}
	onconfirm={submit}
	oncancel={onclose}
/>
