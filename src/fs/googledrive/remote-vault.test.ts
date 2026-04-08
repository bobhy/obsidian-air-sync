import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveGDriveRemoteVault } from "./remote-vault";
import { REMOTE_VAULT_ROOT } from "../../sync/remote-vault";
import { METADATA_FILE } from "../../constants";
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
	downloadFile: ReturnType<typeof vi.fn>;
	uploadFile: ReturnType<typeof vi.fn>;
	getFile: ReturnType<typeof vi.fn>;
} {
	const findChildByName = vi.fn();
	const createFolder = vi.fn();
	const listFiles = vi.fn();
	const downloadFile = vi.fn();
	const uploadFile = vi.fn();
	const getFile = vi.fn();

	const client = {
		findChildByName,
		createFolder,
		listFiles,
		downloadFile,
		uploadFile,
		getFile,
	} as unknown as DriveClient;

	return { client, findChildByName, createFolder, listFiles, downloadFile, uploadFile, getFile };
}

function metaBuffer(vaultName: string): ArrayBuffer {
	return new TextEncoder().encode(JSON.stringify({ vaultName })).buffer;
}

describe("resolveGDriveRemoteVault", () => {
	let mock: ReturnType<typeof createMockClient>;

	beforeEach(() => {
		mock = createMockClient();
		vi.spyOn(crypto, "randomUUID").mockReturnValue("test-uuid-1234" as `${string}-${string}-${string}-${string}-${string}`);
	});

	describe("first-time setup (no cached folder ID, no existing vaults)", () => {
		it("creates root folder, vault folder, .airsync, and metadata.json", async () => {
			// Root folder doesn't exist
			mock.findChildByName.mockResolvedValueOnce(null);
			// Create root folder
			mock.createFolder.mockResolvedValueOnce(makeFolder("root-folder-id", REMOTE_VAULT_ROOT));
			// List children of root (empty)
			mock.listFiles.mockResolvedValueOnce({ files: [] });
			// Create vault folder
			mock.createFolder.mockResolvedValueOnce(makeFolder("vault-folder-id", "test-uuid-1234"));
			// Create .airsync folder
			mock.createFolder.mockResolvedValueOnce(makeFolder("airsync-folder-id", ".airsync"));
			// Upload metadata.json
			mock.uploadFile.mockResolvedValueOnce(makeDriveFile({ id: "meta-file-id", name: METADATA_FILE }));

			const result = await resolveGDriveRemoteVault(mock.client, "My Vault", undefined);

			expect(result.backendUpdates).toEqual({
				remoteVaultFolderId: "vault-folder-id",
			});
			expect(result.wasCreated).toBe(true);

			// Verify root folder lookup
			expect(mock.findChildByName).toHaveBeenCalledWith("root", REMOTE_VAULT_ROOT, FOLDER_MIME);
			// Verify folders created
			expect(mock.createFolder).toHaveBeenCalledWith(REMOTE_VAULT_ROOT, "root");
			expect(mock.createFolder).toHaveBeenCalledWith("test-uuid-1234", "root-folder-id");
			expect(mock.createFolder).toHaveBeenCalledWith(".airsync", "vault-folder-id");
			// Verify metadata written
			expect(mock.uploadFile).toHaveBeenCalledWith(
				METADATA_FILE, "airsync-folder-id",
				expect.any(ArrayBuffer), "application/json"
			);
		});
	});

	describe("first-time setup with existing matching vault", () => {
		it("finds and links to existing vault by vaultName", async () => {
			// Root folder exists
			mock.findChildByName.mockResolvedValueOnce(makeFolder("root-folder-id", REMOTE_VAULT_ROOT));
			// List children — one existing vault
			const existingVault = makeFolder("existing-vault-folder-id", "existing-uuid");
			mock.listFiles.mockResolvedValueOnce({ files: [existingVault] });
			// Find .airsync in vault
			mock.findChildByName.mockResolvedValueOnce(makeFolder("ss-id", ".airsync"));
			// Find metadata.json
			mock.findChildByName.mockResolvedValueOnce(makeDriveFile({ id: "meta-id", name: METADATA_FILE }));
			// Download metadata.json
			mock.downloadFile.mockResolvedValueOnce(metaBuffer("My Vault"));

			const result = await resolveGDriveRemoteVault(mock.client, "My Vault", undefined);

			expect(result.backendUpdates).toEqual({
				remoteVaultFolderId: "existing-vault-folder-id",
			});
			expect(result.wasCreated).toBe(false);
		});
	});

	describe("reconnect with cached folder ID", () => {
		it("reuses existing vault folder", async () => {
			// getFile succeeds (folder exists)
			mock.getFile.mockResolvedValueOnce(makeFolder("vault-folder-id", "cached-uuid"));
			// Find .airsync
			mock.findChildByName.mockResolvedValueOnce(makeFolder("ss-id", ".airsync"));
			// Find metadata.json
			mock.findChildByName.mockResolvedValueOnce(makeDriveFile({ id: "meta-id", name: METADATA_FILE }));
			// Download metadata — same vault name
			mock.downloadFile.mockResolvedValueOnce(metaBuffer("My Vault"));
			// Duplicate check: find root folder (no duplicates)
			mock.findChildByName.mockResolvedValueOnce(makeFolder("root-folder-id", REMOTE_VAULT_ROOT));
			mock.listFiles.mockResolvedValueOnce({ files: [makeFolder("vault-folder-id", "cached-uuid")] });
			mock.findChildByName.mockResolvedValueOnce(makeFolder("ss-id", ".airsync"));
			mock.findChildByName.mockResolvedValueOnce(makeDriveFile({ id: "meta-id", name: METADATA_FILE }));
			mock.downloadFile.mockResolvedValueOnce(metaBuffer("My Vault"));

			const result = await resolveGDriveRemoteVault(mock.client, "My Vault", "vault-folder-id");

			expect(result.backendUpdates).toEqual({
				remoteVaultFolderId: "vault-folder-id",
			});
			expect(result.wasCreated).toBe(false);
		});

		it("throws with original error detail when getFile fails", async () => {
			mock.getFile.mockRejectedValueOnce(new Error("Drive API getFile failed: File not found"));

			await expect(
				resolveGDriveRemoteVault(mock.client, "My Vault", "deleted-folder-id")
			).rejects.toThrow("Failed to access remote vault folder: Drive API getFile failed: File not found");
		});
	});

	describe("vault name mismatch (cached folder ID)", () => {
		it("throws when local name differs from remote name in metadata.json", async () => {
			mock.getFile.mockResolvedValueOnce(makeFolder("vault-folder-id", "cached-uuid"));
			// readMetadata: .airsync + metadata.json with a different name
			mock.findChildByName.mockResolvedValueOnce(makeFolder("ss-id", ".airsync"));
			mock.findChildByName.mockResolvedValueOnce(makeDriveFile({ id: "meta-id", name: METADATA_FILE }));
			mock.downloadFile.mockResolvedValueOnce(metaBuffer("Remote Name"));

			await expect(
				resolveGDriveRemoteVault(mock.client, "Local Name", "vault-folder-id")
			).rejects.toThrow(/does not match the Google Drive shared vault name/);
		});

		it("calls promptVaultNameMismatch with local and remote names then throws", async () => {
			mock.getFile.mockResolvedValueOnce(makeFolder("vault-folder-id", "cached-uuid"));
			mock.findChildByName.mockResolvedValueOnce(makeFolder("ss-id", ".airsync"));
			mock.findChildByName.mockResolvedValueOnce(makeDriveFile({ id: "meta-id", name: METADATA_FILE }));
			mock.downloadFile.mockResolvedValueOnce(metaBuffer("Remote Name"));

			const promptVaultNameMismatch = vi.fn().mockResolvedValue(undefined);

			await expect(
				resolveGDriveRemoteVault(mock.client, "Local Name", "vault-folder-id", undefined, {
					promptVaultNameMismatch,
				})
			).rejects.toThrow(/does not match/);

			expect(promptVaultNameMismatch).toHaveBeenCalledWith("Local Name", "Remote Name");
		});

		it("proceeds normally when names match", async () => {
			mock.getFile.mockResolvedValueOnce(makeFolder("vault-folder-id", "cached-uuid"));
			// readMetadata: name matches — no update needed
			mock.findChildByName.mockResolvedValueOnce(makeFolder("ss-id", ".airsync"));
			mock.findChildByName.mockResolvedValueOnce(makeDriveFile({ id: "meta-id", name: METADATA_FILE }));
			mock.downloadFile.mockResolvedValueOnce(metaBuffer("My Vault"));
			// Duplicate check: no duplicates
			mock.findChildByName.mockResolvedValueOnce(makeFolder("root-folder-id", REMOTE_VAULT_ROOT));
			mock.listFiles.mockResolvedValueOnce({ files: [makeFolder("vault-folder-id", "cached-uuid")] });
			mock.findChildByName.mockResolvedValueOnce(makeFolder("ss-id", ".airsync"));
			mock.findChildByName.mockResolvedValueOnce(makeDriveFile({ id: "meta-id", name: METADATA_FILE }));
			mock.downloadFile.mockResolvedValueOnce(metaBuffer("My Vault"));

			const result = await resolveGDriveRemoteVault(mock.client, "My Vault", "vault-folder-id");

			expect(result.backendUpdates.remoteVaultFolderId).toBe("vault-folder-id");
			expect(result.wasCreated).toBe(false);
			expect(mock.uploadFile).not.toHaveBeenCalled();
		});

		it("recreates missing metadata.json without failing", async () => {
			mock.getFile.mockResolvedValueOnce(makeFolder("vault-folder-id", "cached-uuid"));
			// readMetadata: .airsync missing → returns null (no mismatch check)
			mock.findChildByName.mockResolvedValueOnce(null);
			// updateMetadataIfNeeded: .airsync missing → create folder + write metadata
			mock.findChildByName.mockResolvedValueOnce(null);
			mock.createFolder.mockResolvedValueOnce(makeFolder("new-ss-id", ".airsync"));
			mock.uploadFile.mockResolvedValueOnce(makeDriveFile({ id: "new-meta-id", name: METADATA_FILE }));
			// Duplicate check: no duplicates
			mock.findChildByName.mockResolvedValueOnce(makeFolder("root-folder-id", REMOTE_VAULT_ROOT));
			mock.listFiles.mockResolvedValueOnce({ files: [makeFolder("vault-folder-id", "cached-uuid")] });
			mock.findChildByName.mockResolvedValueOnce(null); // no metadata in this folder

			const result = await resolveGDriveRemoteVault(mock.client, "My Vault", "vault-folder-id");

			expect(result.backendUpdates.remoteVaultFolderId).toBe("vault-folder-id");
			expect(mock.uploadFile).toHaveBeenCalledOnce();
		});
	});

	describe("no match creates new vault", () => {
		it("creates new vault when existing vaults have different names", async () => {
			// Root folder exists
			mock.findChildByName.mockResolvedValueOnce(makeFolder("root-folder-id", REMOTE_VAULT_ROOT));
			// List children — one vault with different name
			mock.listFiles.mockResolvedValueOnce({ files: [makeFolder("other-id", "other-uuid")] });
			// Read other vault's metadata
			mock.findChildByName.mockResolvedValueOnce(makeFolder("ss-id", ".airsync"));
			mock.findChildByName.mockResolvedValueOnce(makeDriveFile({ id: "meta-id", name: METADATA_FILE }));
			mock.downloadFile.mockResolvedValueOnce(metaBuffer("Other Vault"));
			// Create new vault
			mock.createFolder.mockResolvedValueOnce(makeFolder("new-vault-id", "test-uuid-1234"));
			mock.createFolder.mockResolvedValueOnce(makeFolder("new-ss-id", ".airsync"));
			mock.uploadFile.mockResolvedValueOnce(makeDriveFile({ id: "new-meta-id", name: METADATA_FILE }));

			const result = await resolveGDriveRemoteVault(mock.client, "My Vault", undefined);

			expect(result.backendUpdates).toEqual({
				remoteVaultFolderId: "new-vault-id",
			});
			expect(result.wasCreated).toBe(true);
		});
	});

	describe("duplicate vault detection (no cached ID)", () => {
		it("throws when two vault folders match the same vaultName and no callbacks given", async () => {
			mock.findChildByName.mockResolvedValueOnce(makeFolder("root-folder-id", REMOTE_VAULT_ROOT));
			mock.listFiles.mockResolvedValueOnce({
				files: [makeFolder("vault-a", "uuid-a"), makeFolder("vault-b", "uuid-b")],
			});
			// vault-a metadata
			mock.findChildByName.mockResolvedValueOnce(makeFolder("ss-a", ".airsync"));
			mock.findChildByName.mockResolvedValueOnce(makeDriveFile({ id: "meta-a", name: METADATA_FILE }));
			mock.downloadFile.mockResolvedValueOnce(metaBuffer("My Vault"));
			// vault-b metadata
			mock.findChildByName.mockResolvedValueOnce(makeFolder("ss-b", ".airsync"));
			mock.findChildByName.mockResolvedValueOnce(makeDriveFile({ id: "meta-b", name: METADATA_FILE }));
			mock.downloadFile.mockResolvedValueOnce(metaBuffer("My Vault"));

			await expect(
				resolveGDriveRemoteVault(mock.client, "My Vault", undefined)
			).rejects.toThrow(/2 remote vault folders/);
		});

		it("calls promptDuplicateVaults and then throws", async () => {
			mock.findChildByName.mockResolvedValueOnce(makeFolder("root-folder-id", REMOTE_VAULT_ROOT));
			mock.listFiles.mockResolvedValueOnce({
				files: [makeFolder("vault-a", "uuid-a"), makeFolder("vault-b", "uuid-b")],
			});
			mock.findChildByName.mockResolvedValueOnce(makeFolder("ss-a", ".airsync"));
			mock.findChildByName.mockResolvedValueOnce(makeDriveFile({ id: "meta-a", name: METADATA_FILE }));
			mock.downloadFile.mockResolvedValueOnce(metaBuffer("My Vault"));
			mock.findChildByName.mockResolvedValueOnce(makeFolder("ss-b", ".airsync"));
			mock.findChildByName.mockResolvedValueOnce(makeDriveFile({ id: "meta-b", name: METADATA_FILE }));
			mock.downloadFile.mockResolvedValueOnce(metaBuffer("My Vault"));

			const promptDuplicateVaults = vi.fn().mockResolvedValue(undefined);

			await expect(
				resolveGDriveRemoteVault(mock.client, "My Vault", undefined, undefined, {
					promptDuplicateVaults,
				})
			).rejects.toThrow(/2 remote vault folders/);

			expect(promptDuplicateVaults).toHaveBeenCalledWith("My Vault", 2);
		});
	});

	describe("duplicate vault detection (with cached ID tiebreaker)", () => {
		it("uses cached folder and calls notify when duplicates are present", async () => {
			// getFile for cachedFolderId succeeds
			mock.getFile.mockResolvedValueOnce(makeFolder("vault-a", "uuid-a"));
			// updateMetadataIfNeeded: .airsync exists, metadata.json exists, name matches
			mock.findChildByName.mockResolvedValueOnce(makeFolder("ss-a", ".airsync"));
			mock.findChildByName.mockResolvedValueOnce(makeDriveFile({ id: "meta-a", name: METADATA_FILE }));
			mock.downloadFile.mockResolvedValueOnce(metaBuffer("My Vault"));
			// Duplicate check: root found, two vaults match
			mock.findChildByName.mockResolvedValueOnce(makeFolder("root-folder-id", REMOTE_VAULT_ROOT));
			mock.listFiles.mockResolvedValueOnce({
				files: [makeFolder("vault-a", "uuid-a"), makeFolder("vault-b", "uuid-b")],
			});
			mock.findChildByName.mockResolvedValueOnce(makeFolder("ss-a", ".airsync"));
			mock.findChildByName.mockResolvedValueOnce(makeDriveFile({ id: "meta-a", name: METADATA_FILE }));
			mock.downloadFile.mockResolvedValueOnce(metaBuffer("My Vault"));
			mock.findChildByName.mockResolvedValueOnce(makeFolder("ss-b", ".airsync"));
			mock.findChildByName.mockResolvedValueOnce(makeDriveFile({ id: "meta-b", name: METADATA_FILE }));
			mock.downloadFile.mockResolvedValueOnce(metaBuffer("My Vault"));

			const notify = vi.fn();

			const result = await resolveGDriveRemoteVault(
				mock.client, "My Vault", "vault-a", undefined, { notify }
			);

			expect(result.backendUpdates.remoteVaultFolderId).toBe("vault-a");
			expect(result.wasCreated).toBe(false);
			expect(notify).toHaveBeenCalledOnce();
			expect(notify.mock.calls[0]?.[0]).toMatch(/2 remote vault folders/);
		});

		it("does not call notify when there are no duplicates", async () => {
			mock.getFile.mockResolvedValueOnce(makeFolder("vault-a", "uuid-a"));
			mock.findChildByName.mockResolvedValueOnce(makeFolder("ss-a", ".airsync"));
			mock.findChildByName.mockResolvedValueOnce(makeDriveFile({ id: "meta-a", name: METADATA_FILE }));
			mock.downloadFile.mockResolvedValueOnce(metaBuffer("My Vault"));
			// Duplicate check: root found, only one vault
			mock.findChildByName.mockResolvedValueOnce(makeFolder("root-folder-id", REMOTE_VAULT_ROOT));
			mock.listFiles.mockResolvedValueOnce({ files: [makeFolder("vault-a", "uuid-a")] });
			mock.findChildByName.mockResolvedValueOnce(makeFolder("ss-a", ".airsync"));
			mock.findChildByName.mockResolvedValueOnce(makeDriveFile({ id: "meta-a", name: METADATA_FILE }));
			mock.downloadFile.mockResolvedValueOnce(metaBuffer("My Vault"));

			const notify = vi.fn();

			const result = await resolveGDriveRemoteVault(
				mock.client, "My Vault", "vault-a", undefined, { notify }
			);

			expect(result.backendUpdates.remoteVaultFolderId).toBe("vault-a");
			expect(notify).not.toHaveBeenCalled();
		});
	});
});
