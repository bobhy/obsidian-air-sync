import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveGDriveRemoteVault } from "./remote-vault";
import { REMOTE_VAULT_ROOT } from "../../sync/remote-vault";
import { FOLDER_MIME } from "./types";
import type { DriveFile } from "./types";
import type { DriveClient } from "./client";

vi.mock("obsidian");

function makeDriveFile(overrides: Partial<DriveFile> & { id: string; name: string }): DriveFile {
	return { mimeType: "application/octet-stream", ...overrides };
}

function makeFolder(id: string, name: string): DriveFile {
	return makeDriveFile({ id, name, mimeType: FOLDER_MIME });
}

function createMockClient(): {
	client: DriveClient;
	findChildByName: ReturnType<typeof vi.fn>;
	createFolder: ReturnType<typeof vi.fn>;
	listFiles: ReturnType<typeof vi.fn>;
} {
	const findChildByName = vi.fn();
	const createFolder = vi.fn();
	const listFiles = vi.fn();

	const client = {
		findChildByName,
		createFolder,
		listFiles,
	} as unknown as DriveClient;

	return { client, findChildByName, createFolder, listFiles };
}

// sanitizeDbName("My Vault") → "My_Vault"
const VAULT_FOLDER_NAME = "My_Vault";

describe("resolveGDriveRemoteVault", () => {
	let mock: ReturnType<typeof createMockClient>;

	beforeEach(() => {
		mock = createMockClient();
	});

	describe("first-time setup (no existing matching folder)", () => {
		it("creates root and vault folder when neither exist", async () => {
			mock.findChildByName.mockResolvedValueOnce(null);
			mock.createFolder.mockResolvedValueOnce(makeFolder("root-id", REMOTE_VAULT_ROOT));
			mock.listFiles.mockResolvedValueOnce({ files: [] });
			mock.createFolder.mockResolvedValueOnce(makeFolder("vault-id", VAULT_FOLDER_NAME));

			const result = await resolveGDriveRemoteVault(mock.client, "My Vault");

			expect(result.backendUpdates).toEqual({ remoteVaultFolder: "vault-id" });
			expect(result.wasCreated).toBe(true);
			expect(mock.createFolder).toHaveBeenCalledWith(REMOTE_VAULT_ROOT, "root");
			expect(mock.createFolder).toHaveBeenCalledWith(VAULT_FOLDER_NAME, "root-id");
		});

		it("creates vault folder in existing root", async () => {
			mock.findChildByName.mockResolvedValueOnce(makeFolder("root-id", REMOTE_VAULT_ROOT));
			mock.listFiles.mockResolvedValueOnce({ files: [] });
			mock.createFolder.mockResolvedValueOnce(makeFolder("vault-id", VAULT_FOLDER_NAME));

			const result = await resolveGDriveRemoteVault(mock.client, "My Vault");

			expect(result.backendUpdates).toEqual({ remoteVaultFolder: "vault-id" });
			expect(result.wasCreated).toBe(true);
			expect(mock.createFolder).toHaveBeenCalledTimes(1);
			expect(mock.createFolder).toHaveBeenCalledWith(VAULT_FOLDER_NAME, "root-id");
		});

		it("creates new folder when only other-named folders exist", async () => {
			mock.findChildByName.mockResolvedValueOnce(makeFolder("root-id", REMOTE_VAULT_ROOT));
			mock.listFiles.mockResolvedValueOnce({
				files: [makeFolder("other-id", "other-vault")],
			});
			mock.createFolder.mockResolvedValueOnce(makeFolder("new-id", VAULT_FOLDER_NAME));

			const result = await resolveGDriveRemoteVault(mock.client, "My Vault");

			expect(result.backendUpdates).toEqual({ remoteVaultFolder: "new-id" });
			expect(result.wasCreated).toBe(true);
		});
	});

	describe("discovery — existing matching folder", () => {
		it("uses existing folder when name matches", async () => {
			mock.findChildByName.mockResolvedValueOnce(makeFolder("root-id", REMOTE_VAULT_ROOT));
			mock.listFiles.mockResolvedValueOnce({
				files: [makeFolder("vault-id", VAULT_FOLDER_NAME)],
			});

			const result = await resolveGDriveRemoteVault(mock.client, "My Vault");

			expect(result.backendUpdates).toEqual({ remoteVaultFolder: "vault-id" });
			expect(result.wasCreated).toBe(false);
			expect(mock.createFolder).not.toHaveBeenCalled();
		});

		it("sanitizes vault name for folder lookup (special chars → underscore)", async () => {
			mock.findChildByName.mockResolvedValueOnce(makeFolder("root-id", REMOTE_VAULT_ROOT));
			// sanitizeDbName("My Vault!") → "My_Vault_"
			mock.listFiles.mockResolvedValueOnce({
				files: [makeFolder("vault-id", "My_Vault_")],
			});

			const result = await resolveGDriveRemoteVault(mock.client, "My Vault!");

			expect(result.backendUpdates).toEqual({ remoteVaultFolder: "vault-id" });
			expect(result.wasCreated).toBe(false);
		});

		it("ignores folders with non-matching names", async () => {
			mock.findChildByName.mockResolvedValueOnce(makeFolder("root-id", REMOTE_VAULT_ROOT));
			mock.listFiles.mockResolvedValueOnce({
				files: [
					makeFolder("vault-a", "other-vault"),
					makeFolder("vault-b", VAULT_FOLDER_NAME),
				],
			});

			const result = await resolveGDriveRemoteVault(mock.client, "My Vault");

			expect(result.backendUpdates).toEqual({ remoteVaultFolder: "vault-b" });
			expect(result.wasCreated).toBe(false);
		});

		it("ignores files with matching name that are not folders", async () => {
			mock.findChildByName.mockResolvedValueOnce(makeFolder("root-id", REMOTE_VAULT_ROOT));
			mock.listFiles.mockResolvedValueOnce({
				files: [makeDriveFile({ id: "file-id", name: VAULT_FOLDER_NAME })],
			});
			mock.createFolder.mockResolvedValueOnce(makeFolder("vault-id", VAULT_FOLDER_NAME));

			const result = await resolveGDriveRemoteVault(mock.client, "My Vault");

			expect(result.wasCreated).toBe(true);
		});
	});

	describe("duplicate vault detection", () => {
		it("throws when two folders share the same sanitized name", async () => {
			mock.findChildByName.mockResolvedValueOnce(makeFolder("root-id", REMOTE_VAULT_ROOT));
			mock.listFiles.mockResolvedValueOnce({
				files: [makeFolder("vault-a", VAULT_FOLDER_NAME), makeFolder("vault-b", VAULT_FOLDER_NAME)],
			});

			await expect(
				resolveGDriveRemoteVault(mock.client, "My Vault")
			).rejects.toThrow(/2 remote vault folders/);
		});

		it("calls promptDuplicateVaults then throws", async () => {
			mock.findChildByName.mockResolvedValueOnce(makeFolder("root-id", REMOTE_VAULT_ROOT));
			mock.listFiles.mockResolvedValueOnce({
				files: [makeFolder("vault-a", VAULT_FOLDER_NAME), makeFolder("vault-b", VAULT_FOLDER_NAME)],
			});
			const promptDuplicateVaults = vi.fn().mockResolvedValue(undefined);

			await expect(
				resolveGDriveRemoteVault(mock.client, "My Vault", undefined, { promptDuplicateVaults })
			).rejects.toThrow(/2 remote vault folders/);

			expect(promptDuplicateVaults).toHaveBeenCalledWith("My Vault", 2);
		});
	});
});
