import { compareSemVer, parseSemVer } from '../semver.js';

interface Comparator {
	op: string;
	version: string;
}
/** Deliberately smaller than npm ranges: whitespace-separated AND comparisons only. */
export function parseMigrationRange(value: string): readonly Comparator[] {
	if (!value || value.length > 256 || value.trim() !== value) {
		throw Error('Invalid migration range');
	}
	const parts = value.split(/ +/);
	if (parts.length > 8) {
		throw Error('Invalid migration range');
	}
	return parts.map((part) => {
		const match = /^(<=|>=|<|>|=)(.+)$/.exec(part);
		if (!match) {
			throw Error('Invalid migration range');
		}
		parseSemVer(match[2]);
		return { op: match[1], version: match[2] };
	});
}
export function matchesMigrationRange(value: string | undefined, version: string): boolean {
	parseSemVer(version);
	return (
		value === undefined ||
		parseMigrationRange(value).every(({ op, version: bound }) => {
			const order = compareSemVer(version, bound);
			switch (op) {
				case '<':
					return order < 0;
				case '<=':
					return order <= 0;
				case '>':
					return order > 0;
				case '>=':
					return order >= 0;
				default:
					return order === 0;
			}
		})
	);
}
