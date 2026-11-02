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
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'client',
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
