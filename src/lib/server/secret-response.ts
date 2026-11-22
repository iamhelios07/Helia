/** Hold enough bytes to reject reflected credentials before any part of them reaches creator code. */
export class SecretResponseGuard {
	private pending = Buffer.alloc(0);
	private patterns: Buffer[];
	private hold: number;
	constructor(values: string[]) {
		this.patterns = [
			...new Set(
				values.flatMap((value) => [
					value,
					JSON.stringify(value).slice(1, -1),
					encodeURIComponent(value)
				])
			)
		].map((value) => Buffer.from(value));
		this.hold = Math.max(0, ...this.patterns.map((value) => value.length - 1));
	}
	push(bytes: Uint8Array, final = false): Uint8Array {
		const input = Buffer.concat([this.pending, bytes]);
		if (this.patterns.some((value) => input.includes(value))) {
			throw new TypeError('Fetch failed');
		}
		const end = final ? input.length : Math.max(0, input.length - this.hold);
		this.pending = input.subarray(end);
		return input.subarray(0, end);
	}
	headers(headers: [string, string][]) {
		for (const [name, value] of headers) {
			if (this.patterns.some((secret) => Buffer.from(name + ': ' + value).includes(secret))) {
				throw new TypeError('Fetch failed');
			}
		}
	}
}
