import { packageObject, requirePackage } from './package/limits.js';
import { packageTimestamp } from './package/manifest.js';
import { contentVersion, releaseHash } from './versioning-validation.js';

export interface InstalledFrom {
	kind: 'package';
	packageFormatVersion: number;
	packageRelease: { contentVersion: string; contentHash: string; createdAt: string };
	versionChanged: boolean;
	installedAt: string;
}

/** Installation metadata is validated independently of authored release content. */
export function parseInstalledFrom(value: unknown): InstalledFrom {
	const row = packageObject(value);
	const release = packageObject(row.packageRelease);
	// Persisted provenance accepts future positive format versions; new installs require v1.
	requirePackage(
		Object.keys(row).sort().join(',') ===
			'installedAt,kind,packageFormatVersion,packageRelease,versionChanged' &&
			Object.keys(release).sort().join(',') === 'contentHash,contentVersion,createdAt' &&
			row.kind === 'package' &&
			Number.isSafeInteger(row.packageFormatVersion) &&
			Number(row.packageFormatVersion) > 0 &&
			typeof row.versionChanged === 'boolean'
	);
	return {
		kind: 'package',
		packageFormatVersion: row.packageFormatVersion as number,
		packageRelease: {
			contentVersion: contentVersion(release.contentVersion),
			contentHash: releaseHash(release.contentHash),
			createdAt: packageTimestamp(release.createdAt)
		},
		versionChanged: row.versionChanged,
		installedAt: packageTimestamp(row.installedAt)
	};
}
