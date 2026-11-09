import 'monaco-editor/features/codicon/register.js';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/editor/contrib/codelens/browser/codeLensCache.js';
import 'monaco-editor/editor/common/services/treeViewsDndService.js';
import 'monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget.js';
import 'monaco-editor/editor/browser/coreCommands.js';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/editor/contrib/comment/browser/comment.js';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js';
import 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import 'monaco-editor/editor/contrib/folding/browser/folding.js';
import 'monaco-editor/editor/contrib/format/browser/formatActions.js';
import 'monaco-editor/editor/contrib/gotoError/browser/gotoError.js';
import 'monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js';
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js';
import 'monaco-editor/editor/contrib/indentation/browser/indentation.js';
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js';
import 'monaco-editor/editor/contrib/links/browser/links.js';
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor.js';
import 'monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js';
import 'monaco-editor/editor/contrib/readOnlyMessage/browser/contribution.js';
import 'monaco-editor/editor/contrib/rename/browser/rename.js';
import 'monaco-editor/editor/contrib/snippet/browser/snippetController2.js';
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js';
import 'monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode.js';
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js';
import 'monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations.js';
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js';
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js';
import 'monaco-editor/languages/definitions/typescript/register.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import JsonWorker from 'monaco-editor/languages/features/json/json.worker.js?worker';
import { jsonDefaults } from 'monaco-editor/languages/features/json/register.js';
import {
	typescriptDefaults,
	ScriptTarget,
	ModuleKind,
	ModuleResolutionKind,
	JsxEmit
} from 'monaco-editor/languages/features/typescript/register.js';

import TypeScriptWorker from './monaco-typescript.worker.ts?worker';

self.MonacoEnvironment = {
	getWorker(_id, label) {
		if (label === 'typescript') {
			return new TypeScriptWorker();
		}
		if (label === 'json') {
			return new JsonWorker();
		}
		return new EditorWorker();
	}
};
for (const defaults of [typescriptDefaults]) {
	defaults.setCompilerOptions({
		target: ScriptTarget.ES2020,
		module: ModuleKind.ESNext,
		moduleResolution: ModuleResolutionKind.NodeJs,
		jsx: JsxEmit.Preserve,
		jsxFactory: 'h',
		strict: true,
		allowNonTsExtensions: true,
		allowImportingTsExtensions: true,
		noEmit: true,
		skipLibCheck: true,
		moduleDetection: 3,
		lib: ['es2022']
	});
	defaults.setEagerModelSync(true);
	defaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false });
}
jsonDefaults.setDiagnosticsOptions({
	validate: true,
	allowComments: false,
	trailingCommas: 'error',
	enableSchemaRequest: false
});
monaco.editor.defineTheme('helia', {
	base: 'vs-dark',
	inherit: true,
	rules: [],
	colors: {
		'editor.background': '#2b2b2b',
		'editor.foreground': '#d4d4d4',
		'editorLineNumber.foreground': '#777777',
		'editorLineNumber.activeForeground': '#bbbbbb',
		'editor.lineHighlightBackground': '#ffffff06',
		'editor.selectionBackground': '#ffffff25',
		'editorWidget.background': '#303030',
		'editorWidget.border': '#555555',
		'scrollbarSlider.background': '#b3b3b344',
		'scrollbarSlider.hoverBackground': '#b3b3b366',
		'editorOverviewRuler.border': '#00000000',
		focusBorder: '#b3b3b355'
	}
});
export { monaco };
