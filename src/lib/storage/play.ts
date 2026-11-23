import { record } from '#lib/games/state/model.js';

/** Strip authoring-only data after a successful build, keeping the persisted source intact. */
export function playValue(
	table: string,
	input: unknown,
	artifact: (kind: 'logic' | 'ui', value: unknown) => string,
	asset: (mime: string, data: string) => string
): unknown {
	const value = record(input);
	if (table === 'blobs') {
		return { ...value, data: 'helia-asset:' + asset(String(value.mime), String(value.data)) };
	}
	if (table !== 'games' && table !== 'snapshots') {
		return input;
	}
	const result = { ...value };
	delete result.code;
	result.scripts = Object.fromEntries(
		Object.entries(record(value.scripts)).map(([id, raw]) => {
			const script = record(raw);
			return [
				id,
				typeof script.compiled === 'string'
					? {
							language: 'typescript',
							source: '',
							artifact: artifact('logic', { version: 1, source: script.compiled })
						}
					: script
			];
		})
	);
	if (value.ui) {
		const ui = record(value.ui);
		if (ui.compiled) {
			const { compiled, ...presentation } = ui;
			result.ui = { ...presentation, modules: {}, artifact: artifact('ui', compiled) };
		}
	}
	if (table === 'games' && value.resources) {
		result.resources = Object.fromEntries(
			Object.entries(record(value.resources)).map(([id, raw]) => {
				const resource = record(raw);
				return [
					id,
					{
						...resource,
						data: 'helia-asset:' + asset(String(resource.mime), String(resource.data))
					}
				];
			})
		);
	}
	return result;
}
