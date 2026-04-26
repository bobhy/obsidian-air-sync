import { copyFile, access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { VAULT_NAME, VAULT_PATH } from "./helpers/env.js";

const execAsync = promisify(exec);

async function exists(path: string): Promise<boolean> {
	try { await access(path); return true; } catch { return false; }
}

function sleep(ms: number): Promise<void> {
	return new Promise<void>((r) => setTimeout(r, ms));
}

export async function setup(): Promise<void> {
	// eslint-disable-next-line obsidianmd/hardcoded-config-path -- test infrastructure, not plugin code
	const pluginDir = join(VAULT_PATH, ".obsidian", "plugins", "obsidian-air-sync");

	if (!await exists(pluginDir)) {
		throw new Error(`Test vault not found at ${VAULT_PATH}. Run "npm run setup:e2e" first.`);
	}

	for (const file of ["main.js", "manifest.json"]) {
		await copyFile(file, join(pluginDir, file));
	}
	if (await exists("styles.css")) {
		await copyFile("styles.css", join(pluginDir, "styles.css"));
	}

	// Disable the destructive-sync modal so tests don't require manual interaction.
	const dataPath = join(pluginDir, "data.json");
	const existing = await exists(dataPath)
		? JSON.parse(await readFile(dataPath, "utf8")) as Record<string, unknown>
		: {};
	await writeFile(dataPath, JSON.stringify({ ...existing, destructiveSyncThreshold: 100 }, null, 2));

	await execAsync(`obsidian vault=${VAULT_NAME}`, { timeout: 10_000 });
	await sleep(3_000);
	await execAsync("obsidian plugin:reload obsidian-air-sync", { timeout: 10_000 });
	await sleep(1_000);
}
