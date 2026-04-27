import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
				process: "readonly",
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
						'manifest.json',
						'vitest.config.ts',
						'vitest.e2e.config.ts',
						'tests/e2e/*.ts',
						'tests/e2e/helpers/*.ts',
						'tests/wdio/*.ts',
						'tests/wdio/cross/*.ts',
						'tests/wdio/helpers/*.ts',
						'tests/wdio/single/*.ts',
					],
					maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 25,
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// wdio test infrastructure runs in Node.js, not inside Obsidian.
		// Type-aware rules are disabled because these files are linted against the default
		// project (tsconfig.json) which lacks wdio type definitions. Runtime type safety is
		// enforced by tsc via tsconfig.wdio.json when running the tests.
		files: ["tests/wdio/**/*.ts"],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
		rules: {
			"import/no-nodejs-modules": "off",
			"import/no-extraneous-dependencies": "off",
			"no-restricted-globals": "off",
			"no-console": "off",
			"no-undef": "off",
			"@typescript-eslint/no-unsafe-call": "off",
			"@typescript-eslint/no-unsafe-return": "off",
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/no-unsafe-member-access": "off",
			"@typescript-eslint/no-unnecessary-type-assertion": "off",
		},
	},
	{
		// E2E test infrastructure runs in Node.js, not inside Obsidian
		files: ["tests/e2e/**/*.ts"],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
		rules: {
			"import/no-nodejs-modules": "off",
			"no-restricted-globals": "off",
			"no-console": "off",
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
	]),
);
