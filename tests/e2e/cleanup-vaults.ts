/**
 * Cleanup: removes stale e2e-*.md files from both local vaults, clears all
 * sync state from IndexedDB, and deletes matching files from Google Drive.
 *
 * Requires Obsidian to be installed and accessible via the obsidian CLI.
 * The script opens the vaults itself; Obsidian does not need to be pre-running.
 *
 * Run with: npm run cleanup:e2e
 */

import { readdir, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { VAULT_NAME, VAULT_PATH, PEER_VAULT_NAME, PEER_VAULT_PATH } from "./helpers/env.js";
import { resolveVaultFolder, listFiles, deleteFile } from "./helpers/gdrive.js";

const execAsync = promisify(exec);

const TEST_FILE_RE = /^e2e-.*\.md$/;

// Must mirror the sanitizeDbName function in src/store/idb-helper.ts.
function sanitizeDbName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// Must mirror the DB name construction in the plugin source:
//   SyncStateStore  — src/sync/state.ts,          DB_NAME_PREFIX = "air-sync"
//   MetadataStore   — src/store/metadata-store.ts, dbNamePrefix  = "air-sync-drive"
function syncStateDbName(vaultName: string): string {
	return `air-sync-${sanitizeDbName(vaultName)}`;
}
function metadataDbName(vaultName: string): string {
	return `air-sync-drive-${sanitizeDbName(vaultName)}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise<void>((r) => setTimeout(r, ms));
}

async function obsidianEval(js: string): Promise<void> {
	await execAsync(`obsidian eval 'code=${js}'`, { timeout: 15_000 });
}

async function openVault(name: string): Promise<void> {
	await execAsync(`obsidian vault=${name}`, { timeout: 10_000 });
	await sleep(3_000);
}

async function pathExists(p: string): Promise<boolean> {
	try { await access(p); return true; } catch { return false; }
}

async function clearLocalFiles(vaultPath: string, label: string): Promise<void> {
	const files = (await readdir(vaultPath).catch(() => [] as string[])).filter(f => TEST_FILE_RE.test(f));
	for (const f of files) {
		await rm(join(vaultPath, f), { force: true });
	}
	console.log(`  local ${label}: ${files.length} file(s) removed`);
}

async function dropIdb(dbName: string): Promise<void> {
	// All vaults in the same Electron instance share one IndexedDB origin, so
	// we can drop any vault's databases from whichever vault is currently focused.
	// IDBHelper.onversionchange closes open connections when deleteDatabase fires,
	// so this will not block even if the plugin has the database open.
	await obsidianEval(
		`new Promise((res, rej) => { const r = indexedDB.deleteDatabase(${JSON.stringify(dbName)}); r.onsuccess = res; r.onerror = () => rej(String(r.error)); })`
	);
}

async function main(): Promise<void> {
	console.log("\nAir Sync e2e cleanup\n");

	// ── 1. Open primary vault ────────────────────────────────────────────────
	console.log(`Opening ${VAULT_NAME}…`);
	await openVault(VAULT_NAME);

	// Pause sync to reduce noise while we mutate state.  Not guaranteed to win
	// the race against the startup sync, but acceptable per design decision.
	await obsidianEval(`app.commands.executeCommandById("obsidian-air-sync:toggle-sync-pause")`);

	// ── 2. Local file cleanup ────────────────────────────────────────────────
	await clearLocalFiles(VAULT_PATH, VAULT_NAME);
	await clearLocalFiles(PEER_VAULT_PATH, PEER_VAULT_NAME);

	// ── 3. IDB cleanup (primary vault) ──────────────────────────────────────
	//
	// clearSyncHistory() empties the SyncStateStore object-stores and resets
	// the lastSyncSignature in InstanceStore for the current vault.
	await obsidianEval(`app.plugins.plugins["obsidian-air-sync"].clearSyncHistory()`);
	// MetadataStore (Drive file cache + changesStartPageToken) is not touched by
	// clearSyncHistory — drop it explicitly.
	await dropIdb(metadataDbName(VAULT_NAME));
	console.log(`  IDB ${VAULT_NAME}: SyncStateStore cleared, MetadataStore dropped, InstanceStore record reset`);

	// Peer-vault IDB databases share the same Electron origin, so we can drop
	// them from here without switching vaults.
	await dropIdb(syncStateDbName(PEER_VAULT_NAME));
	await dropIdb(metadataDbName(PEER_VAULT_NAME));
	console.log(`  IDB ${PEER_VAULT_NAME}: SyncStateStore and MetadataStore dropped`);

	// ── 4. Drive cleanup ─────────────────────────────────────────────────────
	// Both vaults share the same Drive folder, so one pass covers both.
	console.log(`  Scanning Drive folder "${VAULT_NAME}" for test files…`);
	const folderId = await resolveVaultFolder(VAULT_NAME);
	const toDelete = (await listFiles(folderId)).filter(f => TEST_FILE_RE.test(f.name));
	for (const file of toDelete) {
		await deleteFile(file.id);
	}
	console.log(`  Drive: ${toDelete.length} file(s) deleted`);

	// ── 5. Peer vault InstanceStore reset ────────────────────────────────────
	// The InstanceStore record for a vault can only be reset from within that
	// vault's plugin context (clearSyncHistory references this.vaultKey).
	// eslint-disable-next-line obsidianmd/hardcoded-config-path -- test infrastructure, not plugin code
	const peerPluginDir = join(PEER_VAULT_PATH, ".obsidian", "plugins", "obsidian-air-sync");
	if (await pathExists(peerPluginDir)) {
		console.log(`\nOpening ${PEER_VAULT_NAME} to reset InstanceStore record…`);
		await openVault(PEER_VAULT_NAME);
		await obsidianEval(`app.commands.executeCommandById("obsidian-air-sync:toggle-sync-pause")`);
		// The SyncStateStore was deleted above; when the plugin loaded it was
		// re-created empty via onUpgrade.  clearSyncHistory clears it (no-op)
		// and resets the InstanceStore record.
		await obsidianEval(`app.plugins.plugins["obsidian-air-sync"].clearSyncHistory()`);
		console.log(`  IDB ${PEER_VAULT_NAME}: InstanceStore record reset`);

		// Return to primary vault so Obsidian is in a predictable state.
		await openVault(VAULT_NAME);
	}

	console.log("\nDone.\n");
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
