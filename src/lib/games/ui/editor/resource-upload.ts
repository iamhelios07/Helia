import { parseResources, RESOURCE_LIMITS, type GameResources } from '../../resources.js';

export const ACCEPTED_RESOURCES =
	'image/png,image/jpeg,image/webp,image/gif,audio/mpeg,audio/wav,audio/ogg,video/mp4,video/webm';

function readResource(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			if (typeof reader.result === 'string') {
				resolve(reader.result);
			} else {
				reject(Error('파일을 읽지 못했어요.'));
			}
		};
		reader.onerror = () => reject(Error('파일을 읽지 못했어요.'));
		reader.readAsDataURL(file);
	});
}

export async function uploadResources(files: File[], existing: GameResources, target: string) {
	const resources = { ...existing };
	let first = '';
	for (const file of files) {
		if (file.size > RESOURCE_LIMITS.fileBytes) {
			throw Error('각 파일은 1 MiB까지 추가할 수 있어요.');
		}
		if (!ACCEPTED_RESOURCES.split(',').includes(file.type)) {
			throw Error('지원하는 이미지·오디오·동영상 파일을 선택해주세요.');
		}
		const id = 'asset-' + crypto.randomUUID();
		if (!first) {
			first = id;
		}
		resources[id] = {
			name: target ? target + '/' + file.name : file.name,
			mime: file.type,
			data: await readResource(file)
		};
	}
	return { resources: parseResources(resources), first };
}
