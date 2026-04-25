import { Notice, Platform, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, AirSyncSettings, toSyncable } from "./settings";
import { InstanceStore, InstanceSettings, vaultInstanceKey } from "./store/instance-store";
import { resolveClientId } from "./store/client-id";
import { AirSyncSettingTab } from "./ui/settings";
import { JoinConflictModal } from "./ui/join-conflict-modal";
import { DestructiveSyncModal } from "./ui/destructive-sync-modal";
import { LocalFs } from "./fs/local/index";
import { BackendManager } from "./fs/backend-manager";
import { initRegistry } from "./fs/registry";
import type { ISecretStore } from "./fs/secret-store";
import type { SyncStatus } from "./sync/orchestrator";
import { SyncOrchestrator } from "./sync/orchestrator";
import { SyncScheduler } from "./sync/scheduler";
import { LocalChangeTracker } from "./sync/local-tracker";
import { Logger, getDeviceName } from "./logging/logger";
import type { LoggerAdapter } from "./logging/logger";

function extractInstance(settings: AirSyncSettings, vaultPath: string, lastSyncSignature: string): InstanceSettings {
	const backendInstance: Record<string, { accessTokenExpiry: number }> = {};
	for (const [type, data] of Object.entries(settings.backendData)) {
		if (typeof data.accessTokenExpiry === "number") {
			backendInstance[type] = { accessTokenExpiry: data.accessTokenExpiry };
		}
	}
	return {
		enableLogging: settings.enableLogging,
		logLevel: settings.logLevel,
		backendInstance,
		lastSyncSignature,
		vaultPath,
	};
}

function mergeBackendInstance(
	backendData: Record<string, Record<string, unknown>>,
	backendInstance: Record<string, { accessTokenExpiry: number }>,
): Record<string, Record<string, unknown>> {
	const result: Record<string, Record<string, unknown>> = {};
	for (const [type, data] of Object.entries(backendData)) {
		result[type] = { ...data };
	}
	for (const [type, inst] of Object.entries(backendInstance)) {
		result[type] = { ...(result[type] ?? {}), ...inst };
	}
	return result;
}

export default class AirSyncPlugin extends Plugin {
	settings!: AirSyncSettings;
	private instanceStore: InstanceStore = new InstanceStore();
	clientId = "";
	private localFs: LocalFs | null = null;
	backendManager!: BackendManager;
	private statusBarEl: HTMLElement | null = null;
	private syncStatus: SyncStatus = "not_connected";
	private syncPaused = false;
	private orchestrator!: SyncOrchestrator;
	private scheduler!: SyncScheduler;
	private localTracker!: LocalChangeTracker;
	private settingTab: AirSyncSettingTab | null = null;
	private logger!: Logger;
	/** True when loadSettings() found no stored settings (fresh install or reinstall). */
	private settingsWereAbsent = false;

	async onload() {
		this.clientId = await resolveClientId(this.instanceStore);
		await this.loadSettings();

		const secretStore: ISecretStore = {
			getSecret: (key) => this.app.secretStorage.getSecret(key),
			setSecret: (key, value) => { this.app.secretStorage.setSecret(key, value); },
		};
		initRegistry(secretStore);

		this.localFs = new LocalFs(this.app, () => this.settings.syncDotPaths);

		const deviceName = getDeviceName(Platform.isMobile, this.clientId);
		this.logger = new Logger(
			this.app.vault.adapter as unknown as LoggerAdapter,
			() => this.settings,
			deviceName,
		);
		this.logger.info("Plugin loaded", { deviceName, vaultName: this.app.vault.getName() });

		this.backendManager = new BackendManager({
			getSettings: () => this.settings,
			saveSettings: () => this.saveSettings(),
			getApp: () => this.app,
			getLogger: () => this.logger,
			getVaultName: () => this.app.vault.getName(),
			onConnected: () => {
				this.syncStatus = "idle";
				this.updateStatusBar();
			},
			onDisconnected: () => {
				this.syncStatus = "not_connected";
				this.updateStatusBar();
			},
			onSyncTargetChanged: async () => {
				await this.orchestrator?.clearSyncState();
			},
			notify: (message) => {
				new Notice(message);
			},
			refreshSettingsDisplay: () => {
				this.settingTab?.display();
			},
			hasSyncHistory: () =>
				this.orchestrator
					? this.orchestrator.hasSyncHistory()
					: Promise.resolve(false),
			localHasContentFiles: () => this.localFs?.hasContentFiles() ?? false,
			reloadSettings: () => this.loadSettings(),
			promptJoinConflict: (vaultName) =>
				JoinConflictModal.prompt(this.app, vaultName),
		});

		this.localTracker = new LocalChangeTracker();

		this.orchestrator = new SyncOrchestrator({
			getSettings: () => this.settings,
			getVaultName: () => this.app.vault.getName(),
			saveSettings: () => this.saveSettings(),
			localFs: () => this.localFs,
			remoteFs: () => this.backendManager.getRemoteFs(),
			backendProvider: () => this.backendManager.getBackendProvider(),
			isMobile: () => Platform.isMobile,
			onStatusChange: (status) => {
				this.syncStatus = status;
				this.updateStatusBar();
			},
			onProgress: (text) => {
				this.statusBarEl?.setText(text);
			},
			notify: (message, durationMs) => {
				new Notice(message, durationMs);
			},
			localTracker: this.localTracker,
			logger: this.logger,
			isBackendConnecting: () => this.backendManager.isConnecting(),
			isPaused: () => this.syncPaused,
			clientId: this.clientId,
			getLocalSignature: async () => {
				const stored = await this.instanceStore.load(this.vaultKey);
				return stored.lastSyncSignature;
			},
			saveLocalSignature: async (sig: string) => {
				await this.instanceStore.save(
					this.vaultKey,
					extractInstance(this.settings, this.vaultPath, sig),
				);
			},
			confirmDestructiveSync: (count, total, threshold) =>
				DestructiveSyncModal.prompt(this.app, count, total, threshold),
		});

		this.scheduler = new SyncScheduler({
			workspace: this.app.workspace,
			vault: this.app.vault,
			localFs: () => this.localFs,
			remoteFs: () => this.backendManager.getRemoteFs(),
			stateStore: this.orchestrator.state,
			localTracker: this.localTracker,
			orchestrator: this.orchestrator,
			isExcluded: (path) => this.orchestrator.isExcluded(path),
			registerEvent: (ref) => this.registerEvent(ref),
			register: (cb) => this.register(cb),
		});

		// If settings were absent on startup (fresh install or reinstall), stale IDB
		// sync records may survive from a previous installation. Clear them now so the
		// first sync performs a cold scan instead of incorrectly treating previously
		// synced files as locally deleted.
		if (this.settingsWereAbsent) {
			this.logger.info(
				"Settings not found on startup — stale sync records will be discarded",
				{ reason: "reinstall_or_fresh_install" },
			);
			await this.orchestrator.clearSyncState();
			this.logger.info("Stale sync records cleared — cold scan will be initiated on next sync");
		}

		this.settingTab = new AirSyncSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		// Handle OAuth callback via obsidian://air-sync-auth?access_token=...&state=... or ?code=...&state=...
		this.registerObsidianProtocolHandler("air-sync-auth", (params) => {
			if (!params.access_token && !params.code) {
				new Notice("Authorization failed: no token or code received");
				return;
			}
			// Synthetic URL to pass tokens/code to completeAuth(), which parses callback URL params
			const url = new URL("https://callback");
			for (const [key, value] of Object.entries(params)) {
				url.searchParams.set(key, value);
			}
			void this.backendManager.completeBackendConnect(url.toString());
		});

		// Initialize backend if configured
		await this.backendManager.initBackend();

		// Commands
		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => {
				void this.runSync();
			},
		});

		this.addCommand({
			id: "toggle-sync-pause",
			name: "Pause sync",
			callback: () => {
				this.syncPaused = !this.syncPaused;
				new Notice(this.syncPaused ? "Air Sync: sync paused" : "Air Sync: sync resumed");
			},
		});

		// Ribbon icon
		this.addRibbonIcon("cloud", "Sync now", () => {
			void this.runSync();
		});

		// Status bar
		this.statusBarEl = this.addStatusBarItem();
		this.updateStatusBar();

		this.scheduler.start();
	}

	onunload() {
		void this.logger.flush();
		this.logger.dispose();
		this.backendManager.close();
		this.scheduler.destroy();
		this.orchestrator.close().catch((e) => {
			this.logger.error("Failed to close orchestrator", { message: e instanceof Error ? e.message : String(e) });
		});
		this.instanceStore.close().catch(() => {});
	}

	private get vaultKey(): string {
		return vaultInstanceKey(this.app.vault.getName());
	}

	/** Absolute vault path on desktop; empty string on mobile. */
	private get vaultPath(): string {
		const fsAdapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
		return typeof fsAdapter.getBasePath === "function" ? fsAdapter.getBasePath() : "";
	}

	async loadSettings() {
		const rawDiskData: unknown = await this.loadData();
		this.settingsWereAbsent = rawDiskData === null || rawDiskData === undefined;
		const diskData = (rawDiskData ?? {}) as Partial<AirSyncSettings>;
		const instanceData = await this.instanceStore.load(this.vaultKey);

		// Vault-path collision guard: detect two vaults with the same name but different paths.
		const currentPath = this.vaultPath;
		if (instanceData.vaultPath && currentPath && instanceData.vaultPath !== currentPath) {
			const msg =
				`Air Sync: vault name collision detected. ` +
				`This vault is at "${currentPath}" but the name "${this.app.vault.getName()}" ` +
				`was previously used by a vault at "${instanceData.vaultPath}". ` +
				`Rename one of the vaults to resolve the conflict. Plugin will not initialize.`;
			throw new Error(msg);
		}

		this.settings = {
			...DEFAULT_SETTINGS,
			...diskData,
			// Instance fields always win over anything in settings.json
			enableLogging: instanceData.enableLogging,
			logLevel: instanceData.logLevel,
			backendData: mergeBackendInstance(
				diskData.backendData ?? {},
				instanceData.backendInstance,
			),
		};

		// Ensure the plugin folder is always included in syncDotPaths by default.
		// Added here (not in DEFAULT_SETTINGS) because the path depends on the
		// actual install directory (this.manifest.dir), not a hardcoded name.
		const pluginPath = this.manifest.dir;
		if (pluginPath && !this.settings.syncDotPaths.includes(pluginPath)) {
			this.settings.syncDotPaths = [pluginPath, ...this.settings.syncDotPaths];
			await this.saveSettings();
		}
	}

	async saveSettings() {
		await this.saveData(toSyncable(this.settings));
		const stored = await this.instanceStore.load(this.vaultKey);
		await this.instanceStore.save(
			this.vaultKey,
			extractInstance(this.settings, this.vaultPath, stored.lastSyncSignature),
		);
	}

	async runSync(): Promise<void> {
		if (this.orchestrator.isSyncing()) return;
		try {
			if (!this.localFs || !this.backendManager.getRemoteFs()) {
				await this.backendManager.initBackend();
				if (!this.localFs || !this.backendManager.getRemoteFs()) {
					this.syncStatus = "not_connected";
					this.updateStatusBar();
					new Notice("Not connected to a remote backend");
					return;
				}
			}
			await this.orchestrator.runSync();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.syncStatus = "error";
			this.updateStatusBar();
			new Notice(`Sync error: ${msg}`);
			this.logger.error("Unhandled sync error", { error: msg });
		}
	}

	/** Clear all local sync history and the cached signature (forces full sync next time). */
	async clearSyncHistory(): Promise<void> {
		await this.instanceStore.save(
			this.vaultKey,
			extractInstance(this.settings, this.vaultPath, "0"),
		);
		await this.orchestrator.clearSyncState();
	}

	/** True when the client ID is a generated UUID (user-editable), false when it is a hostname (read-only). */
	get isClientIdEditable(): boolean {
		return this.clientId.startsWith("Client_");
	}

	/** Update the client ID (only valid when isClientIdEditable is true). Clears sync history. */
	async updateClientId(newId: string): Promise<void> {
		await this.instanceStore.saveDevice({ clientId: newId });
		this.clientId = newId;
		await this.clearSyncHistory();
	}

	private updateStatusBar(): void {
		if (!this.statusBarEl) return;
		switch (this.syncStatus) {
			case "idle":
				this.statusBarEl.setText("Synced");
				break;
			case "syncing":
				this.statusBarEl.setText("Syncing...");
				break;
			case "error":
				this.statusBarEl.setText("Sync error");
				break;
			case "partial_error":
				this.statusBarEl.setText("Synced (with errors)");
				break;
			case "not_connected":
				this.statusBarEl.setText("Not connected");
				break;
		}
	}
}
