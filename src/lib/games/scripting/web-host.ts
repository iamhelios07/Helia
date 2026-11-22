import { decodeBytes, encodeBytes, NETWORK_LIMITS } from '#lib/games/network/protocol.js';

import type { SecretReadAccess } from '../secrets/protocol.js';

import { WEB_TYPES, type WebType } from './web-api.js';
import { validateWebConstruction } from './web-limits.js';

type WebRecord = { type: string; value: object };
type Call = {
	op: string;
	type?: string;
	id?: number;
	name?: string;
	args?: unknown[];
	value?: unknown;
};
/** Native Web objects remain in the trusted Worker. The VM receives only JSON and bytes. */
export class ScriptWebHost {
	private readonly objects = new Map<number, WebRecord>();
	private readonly ids = new WeakMap<object, number>();
	private nextId = 0;
	private calls = 0;
	private blobBytes = 0;
	constructor(
		private send: typeof fetch,
		private secrets?: SecretReadAccess
	) {}
	sync(json: string): string {
		try {
			return JSON.stringify({ ok: true, value: this.pack(this.execute(this.input(json), false)) });
		} catch (error) {
			return this.failure(error);
		}
	}
	async async(json: string): Promise<string> {
		try {
			const input = this.input(json);
			let result: unknown;
			if (input.op === 'secret') {
				result = await this.secret(input);
			} else if (input.op === 'fetch') {
				result = await this.fetch(input);
			} else {
				result = await this.execute(input, true);
			}
			return JSON.stringify({ ok: true, value: this.pack(result) });
		} catch (error) {
			return this.failure(error);
		}
	}
	private async secret(input: Call) {
		const args = this.unpack(input.args) as unknown[];
		if (!this.secrets || !Array.isArray(args) || typeof args[0] !== 'string') {
			throw new TypeError('Secret unavailable');
		}
		if (input.name === 'has') {
			return this.secrets.has(args[0]);
		}
		if (input.name === 'ref') {
			return this.secrets.ref(args[0]);
		}
		throw new TypeError('Secret unavailable');
	}
	private input(json: string): Call {
		if (json.length > NETWORK_LIMITS.requestBytes * 1.4 + 32768 || ++this.calls > 4096) {
			throw new TypeError('Web limit');
		}
		const input: unknown = JSON.parse(json);
		if (!input || typeof input !== 'object' || !('op' in input) || typeof input.op !== 'string') {
			throw new TypeError('Web request');
		}
		return input as Call;
	}
	private failure(error: unknown) {
		const name = error instanceof Error || error instanceof DOMException ? error.name : 'TypeError';
		return JSON.stringify({
			ok: false,
			name: ['AbortError', 'TimeoutError', 'SyntaxError', 'RangeError'].includes(name)
				? name
				: 'TypeError',
			message: 'Web operation failed'
		});
	}
	private async fetch(input: Call) {
		const args = this.unpack(input.args) as [RequestInfo | URL, RequestInit?];
		return this.send(...args);
	}
	private execute(input: Call, async: boolean): unknown {
		const record = input.id === undefined ? undefined : this.objects.get(input.id);
		const type = record?.type ?? input.type ?? '';
		const spec = Object.hasOwn(WEB_TYPES, type) ? WEB_TYPES[type] : undefined;
		if (!spec) {
			throw new TypeError('Web type');
		}
		const args = this.unpack(input.args ?? []) as unknown[];
		const constructor: unknown = Reflect.get(globalThis, type);
		if (input.op === 'new' && spec.construct && typeof constructor === 'function' && !async) {
			validateWebConstruction(type, args);
			return Reflect.construct(constructor, args);
		}
		if (
			input.op === 'static' &&
			spec.statics?.includes(input.name ?? '') &&
			typeof constructor === 'function' &&
			!async
		) {
			if (
				type === 'AbortSignal' &&
				input.name === 'timeout' &&
				(typeof args[0] !== 'number' || args[0] < 0 || args[0] > NETWORK_LIMITS.idleMs)
			) {
				throw new TypeError('Timeout limit');
			}
			return this.call(constructor, input.name!, args);
		}
		if (!record || typeof input.name !== 'string') {
			throw new TypeError('Web object');
		}
		return this.objectOperation(record, input, args, async);
	}
	private objectOperation(record: WebRecord, input: Call, args: unknown[], async: boolean) {
		const target = record.value,
			spec: WebType = WEB_TYPES[record.type];
		const name = input.name!;
		if (input.op === 'get' && (async ? spec.asyncProperties : spec.properties)?.includes(name)) {
			return Reflect.get(target, name);
		}
		if (input.op === 'set' && spec.writable?.includes(name) && !async) {
			Reflect.set(target, name, this.unpack(input.value));
			return;
		}
		if (input.op !== 'call' || !(async ? spec.async : spec.sync)?.includes(name)) {
			throw new TypeError('Web method');
		}
		const value = this.call(target, name, args);
		return ['entries', 'keys', 'values'].includes(name)
			? Array.from(value as Iterable<unknown>)
			: value;
	}
	private call(target: object, name: string, args: unknown[]) {
		const method: unknown = Reflect.get(target, name);
		if (typeof method !== 'function') {
			throw new TypeError('Web method unavailable');
		}
		return Reflect.apply(method, target, args) as unknown;
	}
	private unpack(value: unknown): unknown {
		if (!value || typeof value !== 'object') {
			return value;
		}
		if (Array.isArray(value)) {
			return value.map((item) => this.unpack(item));
		}
		const input = value as Record<string, unknown>;
		if (input.$web === 'object' && input.value && typeof input.value === 'object') {
			return Object.fromEntries(
				Object.entries(input.value).map(([key, item]) => [key, this.unpack(item)])
			);
		}
		if (input.$web === 'ref') {
			const object = this.objects.get(Number(input.id));
			if (!object) {
				throw new TypeError('Unknown Web reference');
			}
			return object.value;
		}
		if (input.$web === 'bytes' && typeof input.data === 'string') {
			const bytes = decodeBytes(input.data);
			return input.type === 'ArrayBuffer' ? bytes.buffer : bytes;
		}
		if (input.$web === 'undefined') {
			return undefined;
		}
		return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, this.unpack(item)]));
	}
	private pack(value: unknown): unknown {
		if (value === undefined) {
			return { $web: 'undefined' };
		}
		if (!value || typeof value !== 'object') {
			return value;
		}
		if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
			const data =
				value instanceof ArrayBuffer
					? new Uint8Array(value)
					: new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
			return {
				$web: 'bytes',
				type: value instanceof ArrayBuffer ? 'ArrayBuffer' : 'Uint8Array',
				data: encodeBytes(data)
			};
		}
		if (value instanceof Error || value instanceof DOMException) {
			return { $web: 'error', name: value.name, message: 'Web operation failed' };
		}
		const type = this.type(value);
		if (type) {
			return this.reference(value, type);
		}
		if (Array.isArray(value)) {
			return value.map((item) => this.pack(item));
		}
		return {
			$web: 'object',
			value: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.pack(item)]))
		};
	}
	private type(value: object) {
		// File extends Blob, so test the more specific constructor first.
		for (const type of ['File', ...Object.keys(WEB_TYPES).filter((type) => type !== 'File')]) {
			const constructor: unknown = Reflect.get(globalThis, type);
			if (typeof constructor === 'function' && value instanceof constructor) {
				return type;
			}
		}
	}
	private reference(value: object, type: string) {
		let id = this.ids.get(value);
		if (id === undefined) {
			if (this.objects.size >= 512) {
				throw new TypeError('Web object limit');
			}
			if (value instanceof Blob) {
				if (this.blobBytes + value.size > 2 * NETWORK_LIMITS.responseBytes) {
					throw new TypeError('Web Blob memory limit');
				}
				this.blobBytes += value.size;
			}
			id = ++this.nextId;
			this.ids.set(value, id);
			this.objects.set(id, { value, type });
		}
		return { $web: 'ref', id, type };
	}
}
