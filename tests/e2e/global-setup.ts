import { copyFile, access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { VAULT_NAME, VAULT_PATH, PEER_VAULT_NAME, PEER_VAULT_PATH } from "./helpers/env.js";
import { evalVaultSecret } from "./helpers/gdrive.js";

const execAsync = promisify(exec);

async function exists(path: string): Promise<boolean> {
	try { await access(path); return true; } catch { return false; }
}

function sleep(ms: number): Promise<void> {
	return new Promise<void>((r) => setTimeout(r, ms));
}

async function deployPlugin(pluginDir: string): Promise<void> {
	for (const file of ["main.js", "manifest.json"]) {
		await copyFile(file, join(pluginDir, file));
	}
	if (await exists("styles.css")) {
		await copyFile("styles.css", join(pluginDir, "styles.css"));
	}
	const dataPath = join(pluginDir, "data.json");
	const existing = await exists(dataPath)
		? JSON.parse(await readFile(dataPath, "utf8")) as Record<string, unknown>
		: {};
	await writeFile(dataPath, JSON.stringify({ ...existing, destructiveSyncThreshold: 100 }, null, 2));
}

export async function setup(): Promise<void> {
	// eslint-disable-next-line obsidianmd/hardcoded-config-path -- test infrastructure, not plugin code
	const pluginDir = join(VAULT_PATH, ".obsidian", "plugins", "obsidian-air-sync");

	if (!await exists(pluginDir)) {
		throw new Error(`Test vault not found at ${VAULT_PATH}. Run "npm run setup:e2e" first.`);
	}

	await deployPlugin(pluginDir);
	await execAsync(`obsidian vault=${VAULT_NAME}`, { timeout: 10_000 });
	await sleep(3_000);
	await execAsync("obsidian plugin:reload obsidian-air-sync", { timeout: 10_000 });
	await sleep(2_000);

	// eslint-disable-next-line obsidianmd/hardcoded-config-path -- test infrastructure, not plugin code
	const peerPluginDir = join(PEER_VAULT_PATH, ".obsidian", "plugins", "obsidian-air-sync");
	if (await exists(peerPluginDir)) {
		// Read the refresh token from the primary vault before switching away.
		const refreshToken = await evalVaultSecret("air-sync-googledrive-refresh-token");
		if (!refreshToken) {
			console.warn("[global-setup] No refresh token in primary vault — peer vault will not be set up");
		} else {
			await deployPlugin(peerPluginDir);
			await execAsync(`obsidian vault=${PEER_VAULT_NAME}`, { timeout: 10_000 });
			await sleep(3_000);
			// Inject the primary vault's token so the peer vault is authenticated.
			const tokenJson = JSON.stringify(refreshToken);
			await execAsync(
				`obsidian eval 'code=app.secretStorage.setSecret("air-sync-googledrive-refresh-token", ${tokenJson})'`,
				{ timeout: 10_000 },
			);
			await execAsync("obsidian plugin:reload obsidian-air-sync", { timeout: 10_000 });
			await sleep(5_000);
			// Return focus to the primary vault so tests start there.
			await execAsync(`obsidian vault=${VAULT_NAME}`, { timeout: 10_000 });
			await sleep(3_000);
			// Explicitly reload so the plugin re-initializes cleanly after the vault switch.
			await execAsync("obsidian plugin:reload obsidian-air-sync", { timeout: 10_000 });
			await sleep(5_000);
		}
	}
}
