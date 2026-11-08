import path from 'node:path';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import perfectionist from 'eslint-plugin-perfectionist';
import sonarjs from 'eslint-plugin-sonarjs';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),

	js.configs.recommended,
	ts.configs.recommended,
	svelte.configs.recommended,
	// Apply compatibility first so explicit project rules remain enabled.
	prettier,
	svelte.configs.prettier,

	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node }
		},
		rules: {
			'no-undef': 'off'
		}
	},

	// Existing Svelte + TypeScript parser configuration
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser
			}
		}
	},

	// Code readability and maintainability
	{
		files: ['src/**/*.{js,ts,jsx,tsx,svelte}'],
		plugins: {
			sonarjs,
			perfectionist
		},
		rules: {
			// Complexity
			'sonarjs/cognitive-complexity': ['warn', 12],
			'max-depth': ['warn', 3],
			'max-params': ['warn', 4],

			// Duplication
			'sonarjs/no-identical-functions': 'warn',
			'sonarjs/no-duplicated-branches': 'warn',

			// Readability
			'no-nested-ternary': 'warn',
			'no-else-return': 'warn',
			curly: ['warn', 'all'],

			// Import organization
			'perfectionist/sort-imports': [
				'warn',
				{
					type: 'natural',
					order: 'asc',
					sortSideEffects: false,
					internalPattern: ['^\\$lib(?:/|$)', '^#lib(?:/|$)', '^~/.+', '^@/.+', '^#.+']
				}
			]
		}
	},

	// Function length for JS/TS only
	{
		files: ['src/**/*.{js,ts,jsx,tsx}'],
		rules: {
			'max-lines-per-function': [
				'warn',
				{
					max: 80,
					skipBlankLines: true,
					skipComments: true
				}
			]
		}
	},

	// Svelte component-specific limits
	{
		files: ['src/**/*.svelte'],
		rules: {
			'svelte/max-lines-per-block': [
				'warn',
				{
					script: 200,
					template: 300,
					skipBlankLines: true,
					skipComments: true
				}
			]
		}
	}
);
