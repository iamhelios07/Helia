export interface SemVer {
	major: string;
	minor: string;
	patch: string;
	prerelease: string[];
	build: string[];
}

/** SemVer 2.0.0 syntax; numeric components stay strings to avoid precision loss. */
export function parseSemVer(value: string): SemVer {
	const match =
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?$/.exec(
			value
		);
	if (!match || match[0] !== value) {
		throw Error('Invalid semantic version');
	}
	const prerelease = match[4]?.split('.') ?? [];
	if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) {
		throw Error('Invalid semantic version');
	}
	return {
		major: match[1],
		minor: match[2],
		patch: match[3],
		prerelease,
		build: match[5]?.split('.') ?? []
	};
}

function numeric(a: string, b: string): number {
	return Math.sign(a.length - b.length) || lexical(a, b);
}
function lexical(a: string, b: string): number {
	if (a === b) {
		return 0;
	}
	return a < b ? -1 : 1;
}
function prereleasePart(a: string, b: string): number {
	const an = /^\d+$/.test(a),
		bn = /^\d+$/.test(b);
	if (an && bn) {
		return numeric(a, b);
	}
	if (an !== bn) {
		return an ? -1 : 1;
	}
	return lexical(a, b);
}

/** Build metadata does not affect precedence. No compatibility inference is made. */
export function compareSemVer(left: string, right: string): number {
	const a = parseSemVer(left),
		b = parseSemVer(right);
	for (const key of ['major', 'minor', 'patch'] as const) {
		const order = numeric(a[key], b[key]);
		if (order) {
			return order;
		}
	}
	if (!a.prerelease.length || !b.prerelease.length) {
		return Math.sign(b.prerelease.length) - Math.sign(a.prerelease.length);
	}
	for (let index = 0; index < Math.min(a.prerelease.length, b.prerelease.length); index++) {
		const order = prereleasePart(a.prerelease[index], b.prerelease[index]);
		if (order) {
			return order;
		}
	}
	return Math.sign(a.prerelease.length - b.prerelease.length);
}
