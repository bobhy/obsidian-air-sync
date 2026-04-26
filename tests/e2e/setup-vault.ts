/**
 * One-time setup: creates the e2e test vaults, installs the built plugin,
 * and walks the dev through connecting to Google Drive.
 *
 * Run with: npm run setup:e2e
 */

import { mkdir, copyFile, writeFile, access, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import * as readline from "node:readline";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { E2E_ROOT, VAULT_NAME, VAULT_PATH, PEER_VAULT_NAME, PEER_VAULT_PATH } from "./helpers/env.js";
import { evalVaultSecret } from "./helpers/gdrive.js";

const execAsync = promisify(exec);

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

async function cleanStaleNotes(vaultPath: string): Promise<void> {
	const files = await readdir(vaultPath).catch(() => [] as string[]);
	const stale = files.filter(f => /^e2e-.*\.md$/.test(f));
	if (stale.length > 0) {
		console.log(`  Removing ${stale.length} stale test note(s) from ${vaultPath}`);
		for (const f of stale) {
			await rm(join(vaultPath, f), { force: true });
		}
	}
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

	// Clean up stale notes from previous failed runs.
	await cleanStaleNotes(VAULT_PATH);

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

	console.log(`\nPrimary vault ready.\n`);

	await setupPeerVault(token);

	console.log(`Setup complete. Run e2e tests with:\n  npm run test:e2e\n`);
}

async function setupPeerVault(refreshToken: string): Promise<void> {
	// eslint-disable-next-line obsidianmd/hardcoded-config-path -- test infrastructure, not plugin code
	const peerPluginDir = join(PEER_VAULT_PATH, ".obsidian", "plugins", "obsidian-air-sync");

	console.log(`Setting up peer vault: ${PEER_VAULT_NAME}`);

	await mkdir(peerPluginDir, { recursive: true });

	// eslint-disable-next-line obsidianmd/hardcoded-config-path -- test infrastructure, not plugin code
	const peerCommunityPluginsPath = join(PEER_VAULT_PATH, ".obsidian", "community-plugins.json");
	await writeFile(peerCommunityPluginsPath, JSON.stringify(["obsidian-air-sync"], null, 2));

	for (const file of ["main.js", "manifest.json"] as const) {
		await copyFile(file, join(peerPluginDir, file));
	}
	if (await exists("styles.css")) {
		await copyFile("styles.css", join(peerPluginDir, "styles.css"));
	}

	// Clean up stale notes from previous failed runs.
	await cleanStaleNotes(PEER_VAULT_PATH);

	// Bootstrap data.json: share the primary vault's Drive folder via remoteVaultFolderName.
	// remoteVaultFolder must be non-empty so isConnected() passes; resolveRemoteVault will
	// replace it with the real folder ID on first plugin load.
	const peerData = {
		backendType: "googledrive",
		backendData: {
			googledrive: {
				remoteVaultFolder: "pending",
				remoteVaultFolderName: VAULT_NAME,
			},
		},
		destructiveSyncThreshold: 100,
	};
	await writeFile(join(peerPluginDir, "data.json"), JSON.stringify(peerData, null, 2));

	console.log(`Peer vault files created at ${PEER_VAULT_PATH}\n`);

	// Obsidian requires the user to enable community plugins interactively
	// the first time a vault is opened.
	await execAsync(`obsidian vault=${PEER_VAULT_NAME}`, { timeout: 10_000 });
	await new Promise<void>((r) => setTimeout(r, 2_000));

	await prompt(
		`Obsidian has opened the peer vault.\n` +
		`Click "Turn on community plugins" → "I understand the risks" if prompted.\n` +
		`Wait for the Air Sync plugin to load (it should appear in Settings → Community plugins).\n\n` +
		`Press Enter here when the plugin is active: `
	);

	// Inject the primary vault's refresh token into the peer vault's SecretStorage.
	const tokenJson = JSON.stringify(refreshToken);
	await execAsync(
		`obsidian eval 'code=app.secretStorage.setSecret("air-sync-googledrive-refresh-token", ${tokenJson})'`,
		{ timeout: 10_000 },
	);

	// Reload the plugin so it picks up the token and resolves the Drive folder.
	await execAsync("obsidian plugin:reload obsidian-air-sync", { timeout: 10_000 });
	await new Promise<void>((r) => setTimeout(r, 5_000));

	console.log(`Peer vault ready.\n`);
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
