import type { App } from "obsidian";
import type { AirSyncSettings } from "../settings";
import type { IFileSystem } from "./interface";
import type { IBackendProvider } from "./backend";
import type { Logger } from "../logging/logger";
import { getBackendProvider } from "./registry";
import { AuthError } from "./errors";

export interface BackendManagerDeps {
	getSettings: () => AirSyncSettings;
	saveSettings: () => Promise<void>;
	getApp: () => App;
	getLogger: () => Logger;
	getVaultName: () => string;
	onConnected: (remoteFs: IFileSystem) => void;
	onDisconnected: () => void;
	onIdentityChanged: () => Promise<void>;
	notify: (message: string) => void;
	refreshSettingsDisplay: () => void;
	/** Returns true if this device has recorded sync history with the current remote vault. */
	hasSyncHistory: () => Promise<boolean>;
	/** Returns true if the local vault has user content (non-dot files). */
	localHasContentFiles: () => boolean;
	/**
	 * Reload plugin settings from disk (used after seeding settings from remote).
	 * The caller is responsible for calling saveSettings() afterward if needed.
	 */
	reloadSettings: () => Promise<void>;
	/** Prompt the user when local and remote both have content but have never been synced. */
	promptJoinConflict: (vaultName: string) => Promise<"cancel" | "combine">;
}

export class BackendManager {
	private remoteFs: IFileSystem | null = null;
	private backendProvider: IBackendProvider | null = null;
	private lastBackendIdentity: string | null = null;
	private connecting = false;

	constructor(private deps: BackendManagerDeps) {}

	isConnecting(): boolean {
		return this.connecting;
	}

	getRemoteFs(): IFileSystem | null {
		return this.remoteFs;
	}

	getBackendProvider(): IBackendProvider | null {
		return this.backendProvider;
	}

	/** Resolve the backend provider and create the remote IFileSystem */
	async initBackend(): Promise<void> {
		if (this.connecting) return;

		const settings = this.deps.getSettings();
		const provider = getBackendProvider(settings.backendType);
		if (!provider) return;

		this.connecting = true;
		this.backendProvider = provider;

		try {
			const newIdentity = provider.getIdentity(settings);
			if (this.lastBackendIdentity !== null && newIdentity !== this.lastBackendIdentity) {
				this.deps.getLogger().info("Backend identity changed", {
					from: this.lastBackendIdentity,
					to: newIdentity,
				});
				provider.resetTargetState?.(settings);
				await this.deps.onIdentityChanged();
			}
			this.lastBackendIdentity = newIdentity;

			this.remoteFs?.close?.()?.catch((e: unknown) => {
				this.deps.getLogger().warn("Failed to close previous backend", { error: e instanceof Error ? e.message : String(e) });
			});
			if (!provider.isConnected(settings)) {
				this.remoteFs = null;
				this.deps.onDisconnected();
				const data = settings.backendData[provider.type] as Record<string, unknown> | undefined;
				if (data?.remoteVaultFolderId) {
					this.deps.notify("Authentication expired. Please reconnect in settings.");
				}
				return;
			}

			// Remote vault resolution
			if (provider.resolveRemoteVault) {
				await this.resolveRemoteVault(provider, settings);
			}

			this.remoteFs = provider.createFs(this.deps.getApp(), settings, this.deps.getLogger());
			if (this.remoteFs) {
				this.deps.onConnected(this.remoteFs);
				this.deps.getLogger().info("Backend initialized", { backend: settings.backendType });
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.deps.getLogger().error("Failed to initialize backend", { message: msg });
			if (e instanceof AuthError) {
				this.deps.notify("Authentication expired. Please reconnect in settings.");
			}
		} finally {
			this.connecting = false;
		}
	}

	private async resolveRemoteVault(
		provider: IBackendProvider,
		settings: AirSyncSettings,
	): Promise<{ wasCreated: boolean }> {
		const vaultName = this.deps.getVaultName();
		const type = provider.type;
		const backendData = settings.backendData[type] as Record<string, unknown> | undefined;
		const cachedFolderId = backendData?.remoteVaultFolderId as string | undefined;
		const lastKnownName = backendData?.lastKnownVaultName as string | undefined;

		// Skip network call if already linked and name unchanged
		if (cachedFolderId && lastKnownName === vaultName) {
			return { wasCreated: false };
		}

		const result = await provider.resolveRemoteVault!(
			this.deps.getApp(), settings, vaultName, this.deps.getLogger()
		);
		settings.backendData[type] = { ...(settings.backendData[type] ?? {}), ...result.backendUpdates };
		await this.deps.saveSettings();
		return { wasCreated: result.wasCreated };
	}

	/** Start the backend's auth/connection flow */
	async startBackendConnect(): Promise<void> {
		const settings = this.deps.getSettings();
		if (!this.backendProvider) {
			this.backendProvider =
				getBackendProvider(settings.backendType) ?? null;
		}
		if (!this.backendProvider) {
			this.deps.notify("No backend configured");
			return;
		}
		try {
			const type = this.backendProvider.type;
			const current = settings.backendData[type] ?? {};
			const updates = await this.backendProvider.auth.startAuth(current);
			settings.backendData[type] = { ...current, ...updates };
			await this.deps.saveSettings();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.deps.getLogger().error("Failed to start backend connection", { message: msg });
			this.deps.notify(`Connection failed: ${msg}`);
		}
	}

	/** Complete the auth flow with a code/token from the user */
	async completeBackendConnect(code: string): Promise<void> {
		if (this.connecting) return;
		if (!this.backendProvider) {
			this.deps.notify("Start the connection flow first");
			return;
		}

		const settings = this.deps.getSettings();
		this.connecting = true;

		try {
			const type = this.backendProvider.type;
			const backendData = settings.backendData[type] ?? {};
			const updates = await this.backendProvider.auth.completeAuth(
				code,
				backendData,
			);
			settings.backendData[type] = { ...backendData, ...updates };
			await this.deps.saveSettings();

			// Resolve remote vault before creating FS
			let wasCreated = false;
			if (this.backendProvider.resolveRemoteVault) {
				({ wasCreated } = await this.resolveRemoteVault(this.backendProvider, settings));
			}

			this.remoteFs = this.backendProvider.createFs(
				this.deps.getApp(),
				settings,
				this.deps.getLogger()
			);
			if (this.remoteFs) {
				this.deps.onConnected(this.remoteFs);
			}

			await this.handleInitialConnect(wasCreated, this.deps.getVaultName());
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.deps.getLogger().error("Authorization failed", { message: msg });
			this.deps.notify(`Authorization failed: ${msg}`);
		} finally {
			this.connecting = false;
		}

		this.deps.refreshSettingsDisplay();
	}

	/**
	 * Show the appropriate toast (or modal) for the initial-connect scenarios:
	 *
	 * - wasCreated=true   → Case A: no group existed; we just created one
	 * - wasCreated=false, hasSyncHistory=true  → Case B1: rejoining a known group
	 * - wasCreated=false, hasSyncHistory=false, localEmpty   → Case B2: fresh join; seed settings
	 * - wasCreated=false, hasSyncHistory=false, localNotEmpty → Case B3: conflict prompt
	 */
	private async handleInitialConnect(wasCreated: boolean, vaultName: string): Promise<void> {
		if (wasCreated) {
			// Case A: brand new sync group
			this.deps.notify(`No existing group for vault "${vaultName}" found in cloud storage — creating one`);
			return;
		}

		const syncHistory = await this.deps.hasSyncHistory();
		if (syncHistory) {
			// Case B1: this device previously synced with the group
			this.deps.notify(`Resuming sync with group vault "${vaultName}"`);
			return;
		}

		const localEmpty = !this.deps.localHasContentFiles();
		if (localEmpty) {
			// Case B2: fresh device joining existing group — seed settings from remote
			this.deps.notify(`Downloading group vault "${vaultName}" and syncing`);
			await this.seedGroupSettings();
			return;
		}

		// Case B3: local has content but no sync history — ask the user
		const choice = await this.deps.promptJoinConflict(vaultName);
		if (choice === "cancel") {
			// Disconnect — roll back the connection
			await this.disconnectBackend();
		}
		// "combine": proceed with current sync; remote settings already seeded below
		if (choice === "combine") {
			await this.seedGroupSettings();
		}
	}

	/**
	 * Download the plugin's data.json from the remote vault and reload settings.
	 * This seeds the local device with the group's shared settings.
	 */
	private async seedGroupSettings(): Promise<void> {
		if (!this.remoteFs) return;

		const app = this.deps.getApp();
		const remotePath = `${app.vault.configDir}/plugins/obsidian-air-sync/data.json`;

		try {
			const content = await this.remoteFs.read(remotePath);
			await app.vault.adapter.writeBinary(remotePath, content);
			await this.deps.reloadSettings();
			this.deps.getLogger().info("Seeded group settings from remote", { path: remotePath });
		} catch (err) {
			// Remote settings don't exist yet — not an error, just skip
			const msg = err instanceof Error ? err.message : String(err);
			this.deps.getLogger().debug("No remote settings to seed", { message: msg });
		}
	}

	/** Disconnect the current backend */
	async disconnectBackend(): Promise<void> {
		if (!this.backendProvider) return;

		const settings = this.deps.getSettings();
		const type = this.backendProvider.type;
		const resetData = await this.backendProvider.disconnect(settings);
		settings.backendData[type] = resetData;
		await this.deps.saveSettings();

		await this.deps.onIdentityChanged();
		this.lastBackendIdentity = null;

		this.remoteFs = null;
		this.deps.onDisconnected();

		this.deps.refreshSettingsDisplay();
	}

	/** Release resources */
	close(): void {
		this.remoteFs?.close?.()?.catch((e: unknown) => {
			this.deps.getLogger().warn("Failed to close backend on unload", { error: e instanceof Error ? e.message : String(e) });
		});
	}
}
