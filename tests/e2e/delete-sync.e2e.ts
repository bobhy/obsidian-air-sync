import { describe, it, expect, beforeAll } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { VAULT_NAME, VAULT_PATH } from "./helpers/env.js";
import { createNote } from "./helpers/cli.js";
import { resolveVaultFolder, pollForFile, pollForFileGone } from "./helpers/gdrive.js";

let vaultFolderId: string;

beforeAll(async () => {
	vaultFolderId = await resolveVaultFolder(VAULT_NAME);
});

describe("delete sync", () => {
	it("removes a file from GDrive when deleted locally", async () => {
		const name = `e2e-delete-${Date.now()}`;
		const filename = `${name}.md`;
		const localPath = join(VAULT_PATH, filename);

		await createNote(name);
		const file = await pollForFile(vaultFolderId, filename);
		expect(file.name).toBe(filename);

		// OS-level delete — triggers Obsidian's file watcher → vault.on('delete') → sync
		await rm(localPath, { force: true });

		await pollForFileGone(file.id);
	});
});
