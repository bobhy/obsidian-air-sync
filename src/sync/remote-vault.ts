/** Root folder name created in the backend storage */
export const REMOTE_VAULT_ROOT = "obsidian-air-sync";

/** Metadata stored in .airsync/metadata.json inside each remote vault */
export interface RemoteVaultMetadata {
	vaultName: string;
}

/** Result of resolving a remote vault */
export interface RemoteVaultResolution {
	/** Backend-specific data to persist in settings.backendData (e.g., remoteVaultFolderId) */
	backendUpdates: Record<string, unknown>;
	/** True if the remote vault was just created (first-time setup); false if it already existed */
	wasCreated: boolean;
}
