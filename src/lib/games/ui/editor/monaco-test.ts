import { expect } from 'vitest';
import { page } from 'vitest/browser';

import { loadMonaco } from './monaco-project.js';
export async function monacoModel(label: string) {
	const locator = page.getByRole('textbox', { name: label, exact: true });
	await expect.element(locator).toBeVisible();
	const uri = locator.element().closest('[data-model-uri]')?.getAttribute('data-model-uri');
	if (!uri) {
		throw new Error('No Monaco model for ' + label);
	}
	const { monaco } = await loadMonaco();
	const model = monaco.editor.getModel(monaco.Uri.parse(uri));
	if (!model) {
		throw new Error('Disposed Monaco model for ' + label);
	}
	return model;
}
export async function setMonacoSource(label: string, source: string) {
	const model = await monacoModel(label);
	model.pushEditOperations([], [{ range: model.getFullModelRange(), text: source }], () => null);
}
export async function getMonacoSource(label: string) {
	return (await monacoModel(label)).getValue();
}
