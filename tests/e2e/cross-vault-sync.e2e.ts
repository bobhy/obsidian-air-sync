import { describe, it, expect, beforeAll } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { VAULT_NAME, VAULT_PATH, PEER_VAULT_PATH } from "./helpers/env.js";
import {
	openVault,
	openPeerVault,
	createNote,
	triggerSync,
	pollForLocalFile,
	pollForLocalFileGone,
} from "./helpers/cli.js";
import { resolveVaultFolder, pollForFile, pollForFileGone } from "./helpers/gdrive.js";

let vaultFolderId: string;

beforeAll(async () => {
	// Both vaults share the same Drive folder (peer uses remoteVaultFolderName = VAULT_NAME).
	vaultFolderId = await resolveVaultFolder(VAULT_NAME);
});

describe("cross-vault sync", () => {
	it("syncs a new note from vault 1 to vault 2 via Drive", async () => {
		const name = `e2e-cross-create-${Date.now()}`;
		const filename = `${name}.md`;

		// Primary vault creates the note; the vault create event debounces a sync.
		await createNote(name);
		const driveFile = await pollForFile(vaultFolderId, filename);
		expect(driveFile.name).toBe(filename);

		// Switch to peer vault and create a trigger note so the debounced sync
		// runs and pulls the new file down from Drive.
		await openPeerVault();
		await triggerSync();
		await pollForLocalFile(PEER_VAULT_PATH, filename);

		// Cleanup
		await rm(join(PEER_VAULT_PATH, filename), { force: true });
		await openVault();
		await rm(join(VAULT_PATH, filename), { force: true });
		await pollForFileGone(driveFile.id);
	});

	it("deletes a note from vault 1 and removes it from vault 2 via Drive", async () => {
		const name = `e2e-cross-delete1-${Date.now()}`;
		const filename = `${name}.md`;

		// Setup: create in primary, confirm on Drive, pull into peer.
		await createNote(name);
		const driveFile = await pollForFile(vaultFolderId, filename);
		await openPeerVault();
		await triggerSync();
		await pollForLocalFile(PEER_VAULT_PATH, filename);

		// Delete from primary vault. The OS-level rm triggers Obsidian's file
		// watcher → vault delete event → debounced sync → Drive deletion.
		await openVault();
		await rm(join(VAULT_PATH, filename), { force: true });
		await pollForFileGone(driveFile.id, 60_000);

		// Switch to peer vault; trigger a sync so it pulls the deletion.
		await openPeerVault();
		await triggerSync();
		await pollForLocalFileGone(PEER_VAULT_PATH, filename);

		await openVault();
	});

	it("deletes a note from vault 2 and removes it from vault 1 via Drive", async () => {
		const name = `e2e-cross-delete2-${Date.now()}`;
		const filename = `${name}.md`;

		// Setup: create in primary, confirm on Drive, pull into peer.
		await createNote(name);
		const driveFile = await pollForFile(vaultFolderId, filename);
		await openPeerVault();
		await triggerSync();
		await pollForLocalFile(PEER_VAULT_PATH, filename);

		// Delete from peer vault. Obsidian's file watcher picks up the OS-level
		// rm → vault delete event → debounced sync → Drive deletion.
		await rm(join(PEER_VAULT_PATH, filename), { force: true });
		await pollForFileGone(driveFile.id, 60_000);

		// Switch to primary vault; trigger a sync so it pulls the deletion.
		await openVault();
		await triggerSync();
		await pollForLocalFileGone(VAULT_PATH, filename);
	});
});
