/** The only Web capabilities available to logic. No arbitrary property access or host globals. */
export interface WebType {
	construct?: boolean;
	properties?: string[];
	asyncProperties?: string[];
	writable?: string[];
	sync?: string[];
	async?: string[];
	statics?: string[];
	iterator?: string;
}
const body = { async: ['text', 'json', 'blob', 'arrayBuffer', 'formData', 'bytes'] };
export const WEB_TYPES: Record<string, WebType> = {
	Headers: {
		construct: true,
		sync: ['append', 'delete', 'get', 'getSetCookie', 'has', 'set', 'entries', 'keys', 'values'],
		iterator: 'entries'
	},
	Request: {
		construct: true,
		properties: [
			'url',
			'method',
			'headers',
			'body',
			'bodyUsed',
			'signal',
			'cache',
			'credentials',
			'destination',
			'integrity',
			'keepalive',
			'mode',
			'redirect',
			'referrer',
			'referrerPolicy'
		],
		sync: ['clone'],
		...body
	},
	Response: {
		construct: true,
		properties: [
			'url',
			'redirected',
			'type',
			'ok',
			'status',
			'statusText',
			'headers',
			'body',
			'bodyUsed'
		],
		sync: ['clone'],
		statics: ['error', 'redirect', 'json'],
		...body
	},
	Blob: {
		construct: true,
		properties: ['size', 'type'],
		sync: ['slice', 'stream'],
		async: ['text', 'arrayBuffer', 'bytes']
	},
	File: {
		construct: true,
		properties: ['size', 'type', 'name', 'lastModified'],
		sync: ['slice', 'stream'],
		async: ['text', 'arrayBuffer', 'bytes']
	},
	FormData: {
		construct: true,
		sync: ['append', 'delete', 'get', 'getAll', 'has', 'set', 'entries', 'keys', 'values'],
		iterator: 'entries'
	},
	URL: {
		construct: true,
		properties: [
			'href',
			'origin',
			'protocol',
			'username',
			'password',
			'host',
			'hostname',
			'port',
			'pathname',
			'search',
			'searchParams',
			'hash'
		],
		writable: [
			'href',
			'protocol',
			'username',
			'password',
			'host',
			'hostname',
			'port',
			'pathname',
			'search',
			'hash'
		],
		sync: ['toString', 'toJSON'],
		statics: ['canParse', 'parse']
	},
	URLSearchParams: {
		construct: true,
		properties: ['size'],
		sync: [
			'append',
			'delete',
			'get',
			'getAll',
			'has',
			'set',
			'sort',
			'toString',
			'entries',
			'keys',
			'values'
		],
		iterator: 'entries'
	},
	AbortController: { construct: true, properties: ['signal'], sync: ['abort'] },
	AbortSignal: {
		properties: ['aborted', 'reason'],
		sync: ['throwIfAborted'],
		statics: ['abort', 'any', 'timeout']
	},
	ReadableStream: { properties: ['locked'], sync: ['getReader', 'tee'], async: ['cancel'] },
	ReadableStreamDefaultReader: {
		asyncProperties: ['closed'],
		sync: ['releaseLock'],
		async: ['read', 'cancel']
	},
	TextEncoder: { construct: true, properties: ['encoding'], sync: ['encode'] },
	TextDecoder: { construct: true, properties: ['encoding', 'fatal', 'ignoreBOM'], sync: ['decode'] }
};
