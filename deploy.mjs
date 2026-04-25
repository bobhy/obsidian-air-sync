/**
 * Deploy built plugin files to one or more local Obsidian vaults.
 *
 * Usage: node deploy.mjs /path/to/vault1 [/path/to/vault2 ...]
 *   npm run deploy -- /path/to/vault1 [/path/to/vault2 ...]
 */

import { readFileSync, existsSync, copyFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";

const vaultPaths = process.argv.slice(2);
if (vaultPaths.length === 0) {
	console.error("Usage: npm run deploy -- /path/to/vault1 [/path/to/vault2 ...]");
	process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const pluginId = manifest.id;
const FILES = ["main.js", "manifest.json", "styles.css"];

let failed = false;
for (const vaultPath of vaultPaths) {
	if (!existsSync(vaultPath)) {
		console.error(`deploy: vault not found: ${vaultPath}`);
		failed = true;
		continue;
	}

	const pluginDir = join(vaultPath, ".obsidian", "plugins", pluginId);
	mkdirSync(pluginDir, { recursive: true });

	for (const file of FILES) {
		if (existsSync(file)) {
			copyFileSync(file, join(pluginDir, file));
		}
	}

	const dataJson = join(pluginDir, "data.json");
	if (existsSync(dataJson)) {
		rmSync(dataJson);
		console.log(`deploy: ${vaultPath} — removed data.json`);
	}

	console.log(`deploy: ${vaultPath} — done`);
}

if (failed) process.exit(1);
