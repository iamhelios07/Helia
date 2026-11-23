import { parseResources, type GameResources } from '../../resources.js';
import { FRAME_BOOTSTRAP } from './frame-bootstrap.js';
import { FRAME_STYLES } from './frame-styles.js';
import { parseGameUI, type GameUI } from './model.js';

/** Runtime mounting only substitutes host-owned context into a prepared bundle. */
export async function compileGameUI(
	value: GameUI,
	token: string,
	inputResources: GameResources = {},
	resourceURL: (value: string) => string = (value) => value
): Promise<string> {
	const ui = parseGameUI(value);
	const resources = parseResources(inputResources);
	const built = ui.compiled ?? (await (await import('./build.js')).buildGameUI(ui));
	const resourceURLs = Object.fromEntries(
		Object.entries(resources).flatMap(([id, resource]) => [
			[id, resourceURL(resource.data)],
			[resource.name, resourceURL(resource.data)]
		])
	);
	const code = `((run) => {const factories={${built.factories}};run(factories,${JSON.stringify(built.dependencies)},${JSON.stringify(built.entry)},${JSON.stringify(token)},JSON.parse(${JSON.stringify(JSON.stringify(resourceURLs))}));})(function(factories,dependencies,entry,token,resources){${FRAME_BOOTSTRAP}\n})`;
	const origins = [
		...new Set(
			Object.values(resourceURLs)
				.filter((url) => !url.startsWith('data:') && !url.startsWith('blob:'))
				.map((url) => url.slice(0, url.lastIndexOf('/') + 1))
		)
	].join(' ');
	return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: ${origins}; media-src data: blob: ${origins}; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><meta name="referrer" content="no-referrer"><style>${FRAME_STYLES}${ui.styles ? '\n' + ui.styles : ''}</style></head><body><div id="workbench"></div><script>${code.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
}
