import type { DriveClient } from "./client";
import type { Logger } from "../../logging/logger";
import type { RemoteVaultResolution } from "../../sync/remote-vault";
import { REMOTE_VAULT_ROOT } from "../../sync/remote-vault";
import { FOLDER_MIME } from "./types";
import { sanitizeDbName } from "../../store/idb-helper";

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
 * Layout: Drive root / obsidian-air-sync / {sanitizeDbName(vaultName)} /
 *
 * Discovery: list children of the root folder and filter by folder name.
 *   - Zero matches: create a new folder.
 *   - One match: use it.
 *   - Multiple matches: show duplicate modal (if provided) and throw.
 */
export async function resolveGDriveRemoteVault(
	client: DriveClient,
	vaultName: string,
	logger?: Logger,
	callbacks?: RemoteVaultCallbacks,
): Promise<RemoteVaultResolution> {
	const folderName = sanitizeDbName(vaultName);
	const rootFolder = await findOrCreateFolder(client, "root", REMOTE_VAULT_ROOT);
	logger?.debug("Remote vault root folder", { id: rootFolder.id });

	const children = await client.listFiles(rootFolder.id);
	const matches = children.files.filter(
		(f) => f.mimeType === FOLDER_MIME && f.name === folderName,
	);

	if (matches.length === 1) {
		const match = matches[0]!;
		logger?.info("Found existing remote vault", { folderId: match.id, vaultName, folderName });
		return {
			backendUpdates: { remoteVaultFolder: match.id },
			wasCreated: false,
		};
	}

	if (matches.length > 1) {
		logger?.error("Multiple remote vault folders found, cannot determine which to use", {
			count: matches.length,
			vaultName,
			folderName,
		});
		await callbacks?.promptDuplicateVaults?.(vaultName, matches.length);
		throw new Error(
			`Found ${matches.length} remote vault folders for "${vaultName}" in Google Drive. ` +
			`Remove the duplicate(s) and try connecting again.`,
		);
	}

	// No match — create a new remote vault folder
	logger?.info("Creating new remote vault", { folderName, vaultName });
	const vaultFolder = await client.createFolder(folderName, rootFolder.id);

	return {
		backendUpdates: { remoteVaultFolder: vaultFolder.id },
		wasCreated: true,
	};
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
