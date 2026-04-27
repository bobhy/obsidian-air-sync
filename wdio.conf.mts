/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/types" />
/// <reference types="wdio-obsidian-service" />
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

// Single-vault e2e tests. Run with: npm run test:e2e:single
// One-time token setup:  npm run setup:e2e:wdio
export const config: WebdriverIO.Config = {
	runner: "local",
	logLevel: "warn",
	framework: "mocha",
	specs: ["./tests/wdio/single/**/*.e2e.ts"],
	maxInstances: 1,

	// Keep downloaded Obsidian binaries on local disk — avoids EBUSY on NFS.
	cacheDir: join(homedir(), ".obsidian-wdio-cache"),

	capabilities: [
		{
			browserName: "obsidian",
			"wdio:obsidianOptions": {
				appVersion: "latest",
				vault: "tests/vaults/primary",
				plugins: ["."],
			},
		},
	],

	services: ["obsidian"],
	reporters: ["spec"],

	mochaOpts: {
		ui: "bdd",
		timeout: 120_000,
	},

	before: async (_caps, _specs, b) => {
		const br = b as WebdriverIO.Browser;

		// wdio uses a fresh --user-data-dir so secretStorage is empty.
		// Read the saved refresh token and inject it before the plugin initialises.
		let refreshToken = process.env["AIRSYNC_REFRESH_TOKEN"];
		if (!refreshToken) {
			try {
				refreshToken = (await readFile(".e2e-refresh-token", "utf8")).trim();
			} catch {
				throw new Error(
					"No GDrive refresh token. Run: npm run setup:e2e:wdio\n" +
					"Or set the AIRSYNC_REFRESH_TOKEN environment variable.",
				);
			}
		}

		await injectTokenAndReload(br, refreshToken);

		// Cache the token for Drive API calls in the test helpers.
		process.env["AIRSYNC_REFRESH_TOKEN"] = refreshToken;
	},
};

async function injectTokenAndReload(br: WebdriverIO.Browser, refreshToken: string) {
	type PluginWithBackend = {
		backendManager?: {
			getRemoteFs(): unknown;
			initBackend(): Promise<void>;
		};
	};

	// Inject the refresh token and call initBackend() directly on the already-loaded plugin.
	// wdio uses a fresh --user-data-dir so secretStorage is empty at plugin load time,
	// causing initBackend() to skip. We inject the token here and re-trigger it.
	await br.executeObsidian(async ({ app, plugins }, token) => {
		app.secretStorage.setSecret("air-sync-googledrive-refresh-token", token);
		const plugin = plugins["airSync"] as unknown as PluginWithBackend;
		await plugin?.backendManager?.initBackend();
	}, refreshToken);

	// Poll until resolveRemoteVault() (Drive API call inside initBackend) completes.
	await br.waitUntil(
		async () =>
			br.executeObsidian(({ plugins }) => {
				const plugin = plugins["airSync"] as unknown as PluginWithBackend;
				return !!(plugin?.backendManager?.getRemoteFs());
			}),
		{ timeout: 60_000, interval: 1_000, timeoutMsg: "Plugin backend not ready after 60s" },
	);
}
