import type { DriveClient } from "./client";
import type { Logger } from "../../logging/logger";
import type { RemoteVaultResolution, RemoteVaultMetadata } from "../../sync/remote-vault";
import { REMOTE_VAULT_ROOT } from "../../sync/remote-vault";
import { FOLDER_MIME } from "./types";
import type { DriveFile } from "./types";

const AIRSYNC_DIR = ".airsync";
const METADATA_FILE = "metadata.json";

export interface RemoteVaultCallbacks {
	/** Show a transient notification (toast) to the user. */
	notify?: (message: string) => void;
	/**
	 * Show a modal explaining that duplicate vault folders were found and no
	 * tiebreaker is available. The returned promise resolves when the user
	 * dismisses the modal; the caller throws after awaiting it.
	 */
	promptDuplicateVaults?: (vaultName: string, count: number) => Promise<void>;
}

/**
 * Resolve or create a remote vault folder in Google Drive.
 *
 * Layout: Drive root / obsidian-air-sync / {uuid} / .airsync/metadata.json
 *
 * The cached folder ID and last known vault name are read from settings.backendData
 * by the caller (GoogleDriveProvider).
 *
 * Duplicate detection: all sibling vault folders are scanned for the same
 * vaultName. If duplicates are found:
 *   - With cached tiebreaker: toast warning, use the previously connected folder.
 *   - Without tiebreaker: modal explaining the problem, then throws so the
 *     connection attempt fails cleanly.
 */
export async function resolveGDriveRemoteVault(
	client: DriveClient,
	vaultName: string,
	cachedFolderId: string | undefined,
	logger?: Logger,
	callbacks?: RemoteVaultCallbacks,
): Promise<RemoteVaultResolution> {
	if (cachedFolderId) {
		return resolveLinked(client, cachedFolderId, vaultName, logger, callbacks);
	}

	// 2. Find or create the root "obsidian-air-sync" folder
	const rootFolder = await findOrCreateFolder(client, "root", REMOTE_VAULT_ROOT);
	logger?.debug("Remote vault root folder", { id: rootFolder.id });

	// 3. Search for matching vault or create new one
	return resolveNew(client, rootFolder.id, vaultName, logger, callbacks);
}

async function resolveLinked(
	client: DriveClient,
	cachedFolderId: string,
	vaultName: string,
	logger?: Logger,
	callbacks?: RemoteVaultCallbacks,
): Promise<RemoteVaultResolution> {
	// Verify the cached folder still exists and is accessible
	try {
		await client.getFile(cachedFolderId);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to access remote vault folder: ${msg}`);
	}

	// Update metadata.json if vault name changed
	await updateMetadataIfNeeded(client, cachedFolderId, vaultName, logger);

	// Warn if sibling duplicates exist (non-destructive: only looks, never creates)
	const root = await client.findChildByName("root", REMOTE_VAULT_ROOT, FOLDER_MIME);
	if (root) {
		const matches = await findMatchingVaults(client, root.id, vaultName);
		if (matches.length > 1) {
			logger?.warn("Multiple remote vault folders found; using previously connected one", {
				count: matches.length,
				vaultName,
				folderId: cachedFolderId,
			});
			callbacks?.notify?.(
				`Warning: ${matches.length} remote vault folders exist for "${vaultName}" in Google Drive. ` +
				`Using the same folder as your last connection. ` +
				`Remove the duplicate(s) in Google Drive when convenient.`,
			);
		}
	}

	return {
		backendUpdates: { remoteVaultFolderId: cachedFolderId, lastKnownVaultName: vaultName },
		wasCreated: false,
	};
}

async function resolveNew(
	client: DriveClient,
	rootFolderId: string,
	vaultName: string,
	logger?: Logger,
	callbacks?: RemoteVaultCallbacks,
): Promise<RemoteVaultResolution> {
	const matches = await findMatchingVaults(client, rootFolderId, vaultName);

	if (matches.length === 1) {
		const match = matches[0]!;
		logger?.info("Found existing remote vault", { folderId: match.id, vaultName });
		return {
			backendUpdates: { remoteVaultFolderId: match.id, lastKnownVaultName: vaultName },
			wasCreated: false,
		};
	}

	if (matches.length > 1) {
		logger?.error("Multiple remote vault folders found, cannot determine which to use", {
			count: matches.length,
			vaultName,
		});
		await callbacks?.promptDuplicateVaults?.(vaultName, matches.length);
		throw new Error(
			`Found ${matches.length} remote vault folders for "${vaultName}" in Google Drive. ` +
			`Remove the duplicate(s) and try connecting again.`,
		);
	}

	// No match — create a new remote vault
	const remoteVaultId = crypto.randomUUID();
	logger?.info("Creating new remote vault", { id: remoteVaultId, vaultName });

	const vaultFolder = await client.createFolder(remoteVaultId, rootFolderId);
	const airsyncFolder = await client.createFolder(AIRSYNC_DIR, vaultFolder.id);
	await writeMetadata(client, airsyncFolder.id, { vaultName });

	return {
		backendUpdates: { remoteVaultFolderId: vaultFolder.id, lastKnownVaultName: vaultName },
		wasCreated: true,
	};
}

/** Return all vault folders under rootFolderId whose metadata.json matches vaultName. */
async function findMatchingVaults(
	client: DriveClient,
	rootFolderId: string,
	vaultName: string,
): Promise<DriveFile[]> {
	const children = await client.listFiles(rootFolderId);
	const folders = children.files.filter((f) => f.mimeType === FOLDER_MIME);

	const matches: DriveFile[] = [];
	for (const folder of folders) {
		const metadata = await readMetadata(client, folder.id);
		if (metadata?.vaultName === vaultName) {
			matches.push(folder);
		}
	}
	return matches;
}

async function findOrCreateFolder(
	client: DriveClient,
	parentId: string,
	name: string,
): Promise<{ id: string }> {
	const existing = await client.findChildByName(parentId, name, FOLDER_MIME);
	if (existing) return existing;
	return client.createFolder(name, parentId);
}

async function readMetadata(
	client: DriveClient,
	vaultFolderId: string,
): Promise<RemoteVaultMetadata | null> {
	const airsyncFolder = await client.findChildByName(vaultFolderId, AIRSYNC_DIR, FOLDER_MIME);
	if (!airsyncFolder) return null;

	const metaFile = await client.findChildByName(airsyncFolder.id, METADATA_FILE);
	if (!metaFile) return null;

	const content = await client.downloadFile(metaFile.id);
	const text = new TextDecoder().decode(content);
	const parsed: unknown = JSON.parse(text);
	if (!parsed || typeof parsed !== "object" || !("vaultName" in parsed)) return null;
	return parsed as RemoteVaultMetadata;
}

async function writeMetadata(
	client: DriveClient,
	airsyncFolderId: string,
	metadata: RemoteVaultMetadata,
): Promise<void> {
	const content = new TextEncoder().encode(JSON.stringify(metadata)).buffer.slice(0);
	await client.uploadFile(METADATA_FILE, airsyncFolderId, content, "application/json");
}

async function updateMetadataIfNeeded(
	client: DriveClient,
	vaultFolderId: string,
	vaultName: string,
	logger?: Logger,
): Promise<void> {
	const airsyncFolder = await client.findChildByName(vaultFolderId, AIRSYNC_DIR, FOLDER_MIME);
	if (!airsyncFolder) {
		const newFolder = await client.createFolder(AIRSYNC_DIR, vaultFolderId);
		await writeMetadata(client, newFolder.id, { vaultName });
		logger?.info("Created missing metadata.json", { vaultName });
		return;
	}

	const metaFile = await client.findChildByName(airsyncFolder.id, METADATA_FILE);
	if (!metaFile) {
		await writeMetadata(client, airsyncFolder.id, { vaultName });
		logger?.info("Created missing metadata.json", { vaultName });
		return;
	}

	// Read existing and compare
	const content = await client.downloadFile(metaFile.id);
	const text = new TextDecoder().decode(content);
	const parsed: unknown = JSON.parse(text);
	if (
		parsed && typeof parsed === "object" && "vaultName" in parsed &&
		(parsed as RemoteVaultMetadata).vaultName === vaultName
	) {
		return; // No update needed
	}

	// Update metadata.json with new vault name
	const newContent = new TextEncoder().encode(JSON.stringify({ vaultName })).buffer.slice(0);
	await client.uploadFile(METADATA_FILE, airsyncFolder.id, newContent, "application/json", metaFile.id);
	logger?.info("Updated metadata.json vault name", { vaultName });
}
