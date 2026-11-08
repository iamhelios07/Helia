import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import node from '@sveltejs/adapter-node';
import staticAdapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig(({ mode }) => ({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			adapter:
				mode === 'desktop'
					? staticAdapter({
							pages: 'build/desktop',
							assets: 'build/desktop',
							fallback: 'index.html'
						})
					: node({ out: 'build/web' })
		})
	],
	// Lucide's deep imports re-export .svelte files that need Svelte compilation in SSR.
	ssr: { noExternal: ['@lucide/svelte'] },
	server:
		mode === 'desktop'
			? {
					host: '127.0.0.1',
					port: 1420,
					strictPort: true,
					watch: { ignored: ['**/src-tauri/**'] }
				}
			: undefined,
	clearScreen: false,
	worker: { format: 'es' },
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				optimizeDeps: {
					// Discover lazy editor contributions before browser tests mount an editor.
					include: [
						'typescript',
						'@jitl/quickjs-singlefile-browser-release-sync',
						'quickjs-emscripten-core',
						'monaco-editor/features/codicon/register.js',
						'monaco-editor/editor/contrib/codelens/browser/codeLensCache.js',
						'monaco-editor/editor/common/services/treeViewsDndService.js',
						'monaco-editor/languages/features/typescript/ts.worker.js',
						'monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget.js',
						'monaco-editor/editor/browser/coreCommands.js',
						'monaco-editor/editor/contrib/clipboard/browser/clipboard.js',
						'monaco-editor/editor/contrib/comment/browser/comment.js',
						'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js',
						'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js',
						'monaco-editor/editor/contrib/find/browser/findController.js',
						'monaco-editor/editor/contrib/folding/browser/folding.js',
						'monaco-editor/editor/contrib/format/browser/formatActions.js',
						'monaco-editor/editor/contrib/gotoError/browser/gotoError.js',
						'monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js',
						'monaco-editor/editor/contrib/hover/browser/hoverContribution.js',
						'monaco-editor/editor/contrib/indentation/browser/indentation.js',
						'monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js',
						'monaco-editor/editor/contrib/links/browser/links.js',
						'monaco-editor/editor/contrib/multicursor/browser/multicursor.js',
						'monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js',
						'monaco-editor/editor/contrib/readOnlyMessage/browser/contribution.js',
						'monaco-editor/editor/contrib/rename/browser/rename.js',
						'monaco-editor/editor/contrib/snippet/browser/snippetController2.js',
						'monaco-editor/editor/contrib/suggest/browser/suggestController.js',
						'monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode.js',
						'monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js',
						'monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations.js',
						'monaco-editor/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js',
						'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js',
						'monaco-editor/editor/editor.api.js',
						'monaco-editor/languages/definitions/typescript/register.js',
						'monaco-editor/languages/definitions/javascript/register.js',
						'monaco-editor/languages/features/typescript/register.js',
						'monaco-editor/languages/features/json/register.js'
					]
				},
				test: {
					name: 'client',
					fileParallelism: false,
					browser: {
						enabled: true,
						provider: playwright(),
						instances: [{ browser: 'chromium', headless: true }]
					},
					include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					exclude: ['src/lib/server/**']
				}
			},

			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
}));
