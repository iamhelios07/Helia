import { parseScripts } from './model.js';
import { parseGameUI } from './ui/runtime/model.js';

export interface SourceModule {
	language: string;
	source: string;
}
export interface AuthoringBundle {
	modules: Record<string, SourceModule>;
	/** The original object is retained so source editing never erases layout or presentation. */
	value: Record<string, unknown>;
}
export interface CodeDiagnostic {
	module: string;
	line: number;
	column: number;
	message: string;
}

export function readAuthoringBundle(
	source: string,
	kind: 'scripts' | 'ui'
): AuthoringBundle | null {
	const value: unknown = JSON.parse(source);
	if (kind === 'scripts') {
		const modules = parseScripts(value);
		return { modules, value: modules };
	}
	if (value === null) {
		return null;
	}
	const ui = parseGameUI(value);
	return { modules: ui.modules, value: value as Record<string, unknown> };
}

export function writeAuthoringBundle(
	bundle: AuthoringBundle,
	kind: 'scripts' | 'ui',
	modules: Record<string, SourceModule>,
	entry?: string
): string {
	return JSON.stringify(
		kind === 'scripts'
			? modules
			: { ...bundle.value, modules, ...(entry === undefined ? {} : { entry }) },
		null,
		2
	);
}
