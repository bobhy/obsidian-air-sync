import { describe, it, expect, beforeAll } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { VAULT_NAME, VAULT_PATH } from "./helpers/env.js";
import { openVault, createNote } from "./helpers/cli.js";
import { resolveVaultFolder, pollForFile } from "./helpers/gdrive.js";

let vaultFolderId: string;

beforeAll(async () => {
	await openVault();
	vaultFolderId = await resolveVaultFolder(VAULT_NAME);
});

describe("create sync", () => {
	it("uploads a new local file to GDrive", async () => {
		const name = `e2e-create-${Date.now()}`;
		const filename = `${name}.md`;

		await createNote(name);

		const file = await pollForFile(vaultFolderId, filename);
		expect(file.name).toBe(filename);

		await rm(join(VAULT_PATH, filename), { force: true });
	});
});
