import { browser, expect } from "@wdio/globals";
import { before, describe, it } from "mocha";
import { resolveVaultFolder, pollForFile, pollForFileGone } from "../helpers/gdrive.js";

const DRIVE_FOLDER_NAME = "air-sync-e2e";

let vaultFolderId: string;

before(async () => {
	vaultFolderId = await resolveVaultFolder(DRIVE_FOLDER_NAME);
});

describe("delete sync", () => {
	it("removes a file from GDrive when deleted locally", async () => {
		const filename = `e2e-delete-${Date.now()}.md`;

		await browser.executeObsidian(async ({ app }, fn) => {
			await app.vault.create(fn, "");
		}, filename);

		const file = await pollForFile(vaultFolderId, filename, 60_000);
		expect(file.name).toBe(filename);

		// Vault-level delete fires vault.on('delete') → debouncedSync() → Drive deletion.
		// Because create-sync already completed (pollForFile returned), isSyncing() is false
		// and the debounce fires a fresh leading edge immediately.
		await browser.executeObsidian(async ({ app, obsidian }, fn) => {
			const f = app.vault.getAbstractFileByPath(fn);
			if (f instanceof obsidian.TFile) await app.vault.delete(f);
		}, filename);

		await pollForFileGone(file.id, 60_000);
	});
});
