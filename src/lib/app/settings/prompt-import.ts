import { Unpackr } from 'msgpackr/unpack-no-eval';

import { importPromptPreset, parsePromptConfig, type PromptConfig } from '#lib/games/ai/prompts.js';

const MAX_BYTES = 4 * 1024 * 1024;
// Byte substitution table required by the Risu .risup file format.
// Format reference: https://github.com/kwaroran/RisuAI/tree/main/src/ts/rpack
const RPACK_DECODE = Uint8Array.from(
	'2cf7848bc965fbb69faeb3032d0169741fe4a3ecee5c3421934a0f6ae262029e229cfd3cfc71c7c6ad596705706d8a4412fa24865fafd17a47cefe5063dd51066f18e052a8099d56734cb8536cc3a00e19cf3e0d7e07326846ea48f9992eaba449205e5535380cbcd3b1581679280a1ae1f2cdc439dba2ba6072767d95ef7fc8c0de3794bfb51481922545ace7f566a72b365ac113e34b3ae88d831b7c27b09a42eb87aadc548e7826d25729d4b7f82f8f8975f04177c21effd81511e5049717f331d09b00d7cab44f2a3bd9b26bda5da13f3061bd913d4ee6dfbe4d828c1d23109864f485337b9043bba988f1d6a51cf6cc6eb95b0b96edd5e9c5cb08a68040'.match(
		/../g
	)!,
	(hex) => Number.parseInt(hex, 16)
);

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('프롬프트 파일의 형식을 확인해주세요.');
	}
	return value as Record<string, unknown>;
}

async function decompress(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	const format = compressionFormat(bytes);
	const reader = new Blob([bytes])
		.stream()
		.pipeThrough(new DecompressionStream(format))
		.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}
			size += value.byteLength;
			if (size > MAX_BYTES) {
				await reader.cancel();
				throw new Error('압축을 푼 프롬프트 파일은 4MiB 이하여야 해요.');
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const result = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

async function decodeRisu(bytes: Uint8Array<ArrayBuffer>, packed: boolean): Promise<unknown> {
	if (packed) {
		bytes = bytes.map((byte) => RPACK_DECODE[byte]);
	}
	const decoder = new Unpackr({ useRecords: false });
	const envelope = record(decoder.unpack(await decompress(bytes)) as unknown);
	if (
		(envelope.presetVersion !== 0 && envelope.presetVersion !== 2) ||
		envelope.type !== 'preset'
	) {
		throw new Error('지원하지 않는 Risu 프리셋 파일이에요.');
	}
	const encrypted = envelope.preset ?? envelope.pres;
	if (!(encrypted instanceof ArrayBuffer) && !(encrypted instanceof Uint8Array)) {
		throw new Error('Risu 프리셋 파일의 형식을 확인해주세요.');
	}
	const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('risupreset'));
	const key = await crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['decrypt']);
	const content = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: new Uint8Array(12) },
		key,
		encrypted instanceof ArrayBuffer ? encrypted : new Uint8Array(encrypted)
	);
	return decoder.unpack(new Uint8Array(content)) as unknown;
}

/** Decode the file container before passing supported fields through the preset validators. */
export async function readPromptPresetFile(
	file: File
): Promise<{ name: string; config: PromptConfig }> {
	if (file.size > MAX_BYTES) {
		throw new Error('프롬프트 파일은 4MiB 이하여야 해요.');
	}
	const extension = file.name.split('.').at(-1)?.toLowerCase();
	if (!['json', 'preset', 'risupreset', 'risup'].includes(extension ?? '')) {
		throw new Error('JSON 또는 Risu 프리셋 파일을 선택해주세요.');
	}
	let source: unknown;
	try {
		source =
			extension === 'risup' || extension === 'risupreset'
				? await decodeRisu(new Uint8Array(await file.arrayBuffer()), extension === 'risup')
				: JSON.parse(await file.text());
	} catch {
		throw new Error('프롬프트 파일을 읽지 못했어요. 파일 형식을 확인해주세요.');
	}
	const row = record(source);
	try {
		return {
			name: typeof row.name === 'string' ? row.name : '가져온 프롬프트',
			config:
				row.config !== undefined ? parsePromptConfig(record(row.config)) : importPromptPreset(row)
		};
	} catch {
		throw new Error('프롬프트 파일의 내용을 확인해주세요.');
	}
}

function compressionFormat(bytes: Uint8Array): CompressionFormat {
	if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
		return 'gzip';
	}
	return bytes[0] === 0x78 ? 'deflate' : 'deflate-raw';
}
