import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/e2e/**/*.e2e.ts"],
		globalSetup: ["tests/e2e/global-setup.ts"],
		testTimeout: 120_000,
		hookTimeout: 30_000,
		pool: "forks",
		fileParallelism: false,
		reporters: ["verbose"],
	},
});
