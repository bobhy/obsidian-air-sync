/**
 * One-time setup: creates the e2e test vault, installs the built plugin,
 * and walks the dev through connecting to Google Drive.
 *
 * Run with: npm run setup:e2e
 */

import { mkdir, copyFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import * as readline from "node:readline";
import { E2E_ROOT, VAULT_NAME, VAULT_PATH } from "./helpers/env.js";
import { evalVaultSecret } from "./helpers/gdrive.js";

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function prompt(message: string): Promise<void> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise<void>((r) => rl.question(message, () => { rl.close(); r(); }));
}

async function main(): Promise<void> {
	console.log(`\nE2E vault setup`);
	console.log(`  Root:  ${E2E_ROOT}`);
	console.log(`  Vault: ${VAULT_NAME}\n`);

	// Create vault + plugin directory
	// eslint-disable-next-line obsidianmd/hardcoded-config-path -- test infrastructure, not plugin code
	const pluginDir = join(VAULT_PATH, ".obsidian", "plugins", "obsidian-air-sync");
	await mkdir(pluginDir, { recursive: true });

	// Enable community plugins
	// eslint-disable-next-line obsidianmd/hardcoded-config-path -- test infrastructure, not plugin code
	const communityPluginsPath = join(VAULT_PATH, ".obsidian", "community-plugins.json");
	if (!await exists(communityPluginsPath)) {
		await writeFile(communityPluginsPath, JSON.stringify(["obsidian-air-sync"], null, 2));
	}

	// Copy build artifacts
	const artifacts = ["main.js", "manifest.json"] as const;
	for (const file of artifacts) {
		if (!await exists(file)) {
			console.error(`Missing build artifact: ${file}. Run "npm run build" first.`);
			process.exit(1);
		}
		await copyFile(file, join(pluginDir, file));
	}
	if (await exists("styles.css")) {
		await copyFile("styles.css", join(pluginDir, "styles.css"));
	}

	console.log(`Plugin installed to ${pluginDir}\n`);

	await prompt(
		`Open this vault in Obsidian now:\n` +
		`  File → Open vault → Open folder as vault → ${VAULT_PATH}\n\n` +
		`Enable community plugins when prompted, then press Enter here: `
	);

	await prompt(
		`Now connect to Google Drive:\n` +
		`  Settings → Air Sync → Connect to Google Drive\n` +
		`  Complete the OAuth flow in your browser.\n\n` +
		`Press Enter here when authentication is complete: `
	);

	// Verify the token was stored
	const token = await evalVaultSecret("air-sync-googledrive-refresh-token");
	if (!token) {
		console.error("\nNo refresh token in SecretStorage.");
		console.error("Was the plugin loaded and the OAuth flow completed in the test vault?");
		process.exit(1);
	}

	// Validate the token actually works end-to-end before declaring success
	const AUTH_SERVER = "https://auth-smartsync.takezo.dev";
	const validateResponse = await fetch(AUTH_SERVER + "/google/token/refresh", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ refresh_token: token }),
	});
	if (!validateResponse.ok) {
		console.error(`\nRefresh token found but rejected by auth server: ${await validateResponse.text()}`);
		console.error("Try disconnecting and reconnecting to Google Drive in the plugin settings.");
		process.exit(1);
	}

	console.log(`\nSetup complete. Run e2e tests with:\n  npm run test:e2e\n`);
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
