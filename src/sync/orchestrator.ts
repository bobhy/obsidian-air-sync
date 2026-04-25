import type { AirSyncSettings } from "../settings";
import type { IFileSystem } from "../fs/interface";
import type { IBackendProvider } from "../fs/backend";
import type { Logger } from "../logging/logger";
import { AsyncMutex } from "../queue/async-queue";
import { isIgnored } from "../utils/ignore";
import { SyncStateStore } from "./state";
import { LocalChangeTracker } from "./local-tracker";
import { collectChanges } from "./change-detector";
import { planSync } from "./decision-engine";
import { refinePlan } from "./rename-optimizer";
import { executePlan } from "./plan-executor";
import type { ExecutionContext, ExecutionResult } from "./plan-executor";
import { AuthError } from "../fs/errors";
import { getErrorInfo, isRateLimitError, sleep } from "./error";
import type { SyncStatus } from "./types";
import { buildSyncRecord } from "./state-committer";
import { computeSignature, readRemoteSignature, writeRemoteSignature } from "./signature";

export type { SyncStatus };

interface SyncCycleResult {
	result: ExecutionResult;
	succeeded: number;
	failed: number;
	conflicts: number;
}

function buildNotificationMessage(cycle: SyncCycleResult): string {
	const counts = { pushed: 0, pulled: 0, matched: 0, deleted: 0, renamed: 0 };
	for (const a of cycle.result.succeeded) {
		if (a.action.action === "push") counts.pushed++;
		else if (a.action.action === "pull") counts.pulled++;
		else if (a.action.action === "match") counts.matched++;
		else if (a.action.action === "delete_local" || a.action.action === "delete_remote") counts.deleted++;
		else if (a.action.action === "rename_remote" || a.action.action === "rename_local") counts.renamed++;
	}
	const parts: string[] = [];
	if (counts.pushed > 0) parts.push(`${counts.pushed} pushed`);
	if (counts.pulled > 0) parts.push(`${counts.pulled} pulled`);
	if (counts.matched > 0) parts.push(`${counts.matched} matched`);
	if (counts.deleted > 0) parts.push(`${counts.deleted} deleted`);
	if (counts.renamed > 0) parts.push(`${counts.renamed} renamed`);
	if (cycle.conflicts > 0) parts.push(`${cycle.conflicts} conflicts`);
	if (cycle.failed > 0) parts.push(`${cycle.failed} errors`);
	return parts.length === 0 ? "Everything up to date" : `Sync: ${parts.join(", ")}`;
}

export interface SyncOrchestratorDeps {
	getSettings: () => AirSyncSettings;
	getVaultName: () => string;
	saveSettings: () => Promise<void>;
	localFs: () => IFileSystem | null;
	remoteFs: () => IFileSystem | null;
	backendProvider: () => IBackendProvider | null;
	onStatusChange: (status: SyncStatus) => void;
	onProgress: (text: string) => void;
	notify: (message: string, durationMs?: number) => void;
	/** Returns true when running on mobile (used for mobile sync restrictions) */
	isMobile: () => boolean;
	/** Returns true when the backend is in the process of connecting */
	isBackendConnecting?: () => boolean;
	/** Returns true when the user has manually paused sync */
	isPaused?: () => boolean;
	localTracker: LocalChangeTracker;
	logger?: Logger;
	clientId: string;
	getLocalSignature: () => Promise<string>;
	saveLocalSignature: (sig: string) => Promise<void>;
	/**
	 * Called when a sync plan exceeds the destructiveSyncThreshold setting.
	 * Resolves to true to proceed, false to skip the sync cycle.
	 * If absent, the sync proceeds without confirmation.
	 */
	confirmDestructiveSync?: (destructiveCount: number, knownFileCount: number, threshold: number) => Promise<boolean>;
}

const MAX_RETRIES = 3;

export class SyncOrchestrator {
	private syncMutex = new AsyncMutex();
	private stateStore: SyncStateStore;
	private syncPending = false;
	private startupCheckDone = false;
	private deps: SyncOrchestratorDeps;

	constructor(deps: SyncOrchestratorDeps) {
		this.deps = deps;
		this.stateStore = new SyncStateStore(deps.getVaultName());
	}

	get state(): SyncStateStore {
		return this.stateStore;
	}

	isSyncing(): boolean {
		return this.syncMutex.isLocked;
	}

	get isLocked(): boolean {
		return this.syncMutex.isLocked;
	}

	async close(): Promise<void> {
		await this.stateStore.close();
	}

	async clearSyncState(): Promise<void> {
		this.deps.logger?.info("Clearing sync state");
		await this.stateStore.clear();
	}

	/** True if this device has any recorded sync history with the current remote vault. */
	async hasSyncHistory(): Promise<boolean> {
		const records = await this.stateStore.getAll();
		return records.length > 0;
	}

	shouldSync(): boolean {
		const hasRemote = !!this.deps.remoteFs();
		const isLocked = this.syncMutex.isLocked;
		const isConnecting = this.deps.isBackendConnecting?.() ?? false;
		if (!hasRemote || isLocked || isConnecting) {
			this.deps.logger?.debug("shouldSync: skipped", { hasRemote, isLocked, isConnecting });
		}
		return hasRemote && !isLocked && !isConnecting;
	}

	isExcluded(path: string): boolean {
		return isIgnored(path, this.deps.getSettings().ignorePatterns);
	}

	async runSync(): Promise<void> {
		const remoteFs = this.deps.remoteFs();
		if (!remoteFs) {
			this.deps.onStatusChange("not_connected");
			this.deps.logger?.debug("runSync: skipped — no remote backend");
			return;
		}

		if (this.deps.isBackendConnecting?.()) {
			this.deps.logger?.debug("runSync: skipped — backend connecting");
			return;
		}

		if (this.deps.isPaused?.()) {
			this.deps.logger?.debug("runSync: skipped — sync paused");
			return;
		}

		if (this.syncMutex.isLocked) {
			this.syncPending = true;
			return;
		}

		await this.syncMutex.run(async () => {
			do {
				this.syncPending = false;
				this.deps.onStatusChange("syncing");
				this.deps.logger?.info("Sync started");

				const result = await this.executeWithRetry();
				if (!result) return; // Fatal error already handled

				const { succeeded, failed, conflicts } = result;
				if (failed > 0) {
					this.deps.onStatusChange("partial_error");
					this.deps.logger?.warn("Sync completed with errors", { succeeded, conflicts, failed });
				} else {
					this.deps.onStatusChange("idle");
					this.deps.logger?.info("Sync completed", { succeeded, conflicts, failed });
				}

				if (this.deps.getSettings().enableLogging) {
					this.deps.notify(buildNotificationMessage(result));
				}
				await this.deps.logger?.flush();

				const allPaths = this.deps.localTracker.getDirtyPaths();
				this.deps.localTracker.acknowledge(allPaths);
			} while (this.syncPending);
		});
	}

	/**
	 * Execute sync with retry logic. Returns null on fatal error (already reported).
	 */
	private async executeWithRetry(): Promise<SyncCycleResult | null> {
		let lastError: unknown = null;
		let lastResult: ExecutionResult | null = null;

		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			try {
				lastResult = await this.executeSyncOnce();
				return {
					result: lastResult,
					succeeded: lastResult.succeeded.length,
					failed: lastResult.failed.length,
					conflicts: lastResult.conflicts.length,
				};
			} catch (err) {
				lastError = err;
				const { status, retryAfter } = getErrorInfo(err);
				this.deps.logger?.error(
					`Sync error (attempt ${attempt}/${MAX_RETRIES})`,
					{ status, message: err instanceof Error ? err.message : String(err) },
				);

				if (err instanceof AuthError) {
					this.deps.onStatusChange("error");
					this.deps.notify("Authentication error. Please reconnect in settings.");
					return null;
				}
				if (status === 403 && !isRateLimitError(err)) {
					this.deps.onStatusChange("error");
					this.deps.notify("Permission denied. Please check your Google Drive permissions.");
					return null;
				}
				if (status === 404) break;
				if (attempt === MAX_RETRIES) break;

				let delay: number;
				if ((status === 429 || status === 403) && retryAfter !== null) {
					delay = retryAfter * 1000;
				} else {
					const base = Math.pow(2, attempt - 1) * 1000;
					delay = base * (0.5 + Math.random());
				}
				await sleep(delay);
			}
		}

		this.deps.onStatusChange("error");
		const msg = lastError instanceof Error ? lastError.message : "Unknown error";
		this.deps.notify(`Sync error: ${msg}`);
		this.deps.logger?.error("Sync failed after retries", { message: msg });
		await this.deps.logger?.flush();
		return null;
	}

	async pullSingle(path: string): Promise<void> {
		await this.syncMutex.run(async () => {
			const localFs = this.deps.localFs();
			const remoteFs = this.deps.remoteFs();
			if (!localFs || !remoteFs) {
				this.deps.logger?.warn("pullSingle: skipped — no local or remote fs", { path });
				return;
			}

			try {
				const remote = await remoteFs.stat(path);
				if (!remote || remote.isDirectory) {
					this.deps.logger?.warn("pullSingle: remote file not found or is a directory", { path });
					return;
				}

				const content = await remoteFs.read(path);
				const localEntity = await localFs.write(path, content, remote.mtime);
				const remoteEntity = remote;

				const record = buildSyncRecord(localEntity, remoteEntity, path);
				await this.stateStore.put(record);

				this.deps.logger?.info("pullSingle: completed", { path });
			} catch (err) {
				this.deps.logger?.error("pullSingle: failed", {
					path,
					error: err instanceof Error ? err.message : String(err),
				});
			} finally {
				this.deps.localTracker.acknowledge([path]);
			}
		});
	}

	getStatus(): SyncStatus {
		return this.syncMutex.isLocked ? "syncing" : "idle";
	}

	private async executeSyncOnce() {
		const localFs = this.deps.localFs();
		const remoteFs = this.deps.remoteFs();
		if (!localFs || !remoteFs) {
			throw new Error("Cannot sync: local or remote filesystem is not available");
		}
		const settings = this.deps.getSettings();

		// Startup signature check: runs once per session to decide full vs incremental sync
		if (!this.startupCheckDone) {
			this.startupCheckDone = true;
			try {
				const localSig = await this.deps.getLocalSignature();
				const remoteSig = await readRemoteSignature(remoteFs, this.deps.clientId);
				this.deps.logger?.info("Sync signature check", {
					localSig,
					remoteSig,
					clientId: this.deps.clientId,
					match: localSig === remoteSig,
				});
				if (localSig !== remoteSig) {
					this.deps.logger?.warn("Sync signature mismatch — clearing sync state for full sync", {
						localSig,
						remoteSig,
					});
					await this.stateStore.clear();
				}
			} catch (e) {
				this.deps.logger?.warn("Failed to read sync signatures — falling back to full sync", {
					error: e instanceof Error ? e.message : String(e),
				});
				await this.stateStore.clear();
			}
		}

		const changeSet = await collectChanges({
			localFs,
			remoteFs,
			stateStore: this.stateStore,
			localTracker: this.deps.localTracker,
		});

		const renamePairs = this.deps.localTracker.getRenamePairs();
		const remoteOnlyPaths = changeSet.entries.filter((e) => !e.local && e.remote).map((e) => e.path);
		this.deps.logger?.info("Change detection completed", {
			temperature: changeSet.temperature,
			entries: changeSet.entries.length,
			localOnly: changeSet.entries.filter((e) => e.local && !e.remote).length,
			remoteOnly: remoteOnlyPaths.length,
			both: changeSet.entries.filter((e) => e.local && e.remote).length,
			enriched: changeSet.entries.filter((e) => e.local?.hash && !e.prevSync).length,
			renamePairs: renamePairs.size,
		});
		if (remoteOnlyPaths.length > 0) {
			this.deps.logger?.debug("Remote-only paths", { paths: remoteOnlyPaths });
		}
		if (renamePairs.size > 0) {
			const rpPaths = new Set([...renamePairs.keys(), ...renamePairs.values()]);
			const rpEntries = changeSet.entries
				.filter((e) => rpPaths.has(e.path))
				.map((e) => ({
					path: e.path,
					local: !!e.local,
					remote: !!e.remote,
					prevSync: !!e.prevSync,
					hash: (e.local?.hash || e.prevSync?.hash || "").substring(0, 8) || undefined,
				}));
			this.deps.logger?.debug("Rename entry details", { entries: rpEntries });
		}

		const isMobile = this.deps.isMobile();
		const maxBytes = settings.mobileMaxFileSizeMB * 1024 * 1024;
		const filtered = changeSet.entries.filter((e) => {
			if (this.isExcluded(e.path)) return false;
			if (isMobile) {
				const size = Math.max(e.local?.size ?? 0, e.remote?.size ?? 0);
				if (size > maxBytes) return false;
			}
			return true;
		});

		if (filtered.length !== changeSet.entries.length) {
			this.deps.logger?.debug("Files filtered", {
				total: changeSet.entries.length,
				afterFilter: filtered.length,
				excluded: changeSet.entries.length - filtered.length,
			});
		}

		const folderRenamePairs = this.deps.localTracker.getFolderRenamePairs();
		if (folderRenamePairs.size > 0) {
			this.deps.logger?.info("Folder rename pairs detected", {
				count: folderRenamePairs.size,
				pairs: [...folderRenamePairs.entries()].map(([n, o]) => `${o} → ${n}`),
			});
		}
		const plan = refinePlan(
			planSync(filtered),
			renamePairs,
			folderRenamePairs,
			changeSet.remoteRenamePairs,
			this.deps.logger,
		);

		const actionBreakdown: Record<string, number> = {};
		for (const a of plan.actions) {
			actionBreakdown[a.action] = (actionBreakdown[a.action] ?? 0) + 1;
		}
		this.deps.logger?.info("Sync plan created", {
			total: plan.actions.length,
			...actionBreakdown,
		});

		const total = plan.actions.length;

		// Destructive-sync guard: prompt when deletes + overwrites exceed user's threshold
		if (this.deps.confirmDestructiveSync) {
			const threshold = settings.destructiveSyncThreshold;
			const knownFileCount = (await this.stateStore.getAll()).length;
			const destructiveCount = plan.actions.filter(
				(a) => a.action === "delete_local" || (a.action === "pull" && a.local !== undefined),
			).length;
			if (knownFileCount > 0 && destructiveCount / knownFileCount > threshold / 100) {
				const proceed = await this.deps.confirmDestructiveSync(destructiveCount, knownFileCount, threshold);
				if (!proceed) {
					this.deps.logger?.info("Sync skipped by user — destructive plan exceeded threshold", {
						destructiveCount,
						knownFileCount,
						threshold,
					});
					return { succeeded: [], failed: [], conflicts: [] };
				}
			}
		}

		const ctx: ExecutionContext = {
			localFs,
			remoteFs,
			committer: {
				stateStore: this.stateStore,
				enableThreeWayMerge: settings.enableThreeWayMerge,
				localFs,
				logger: this.deps.logger,
			},
			conflictStrategy: settings.conflictStrategy,
			onProgress: (completed: number) => {
				if (total > 0) {
					this.deps.onProgress(`Syncing ${completed}/${total}...`);
				}
			},
			logger: this.deps.logger,
		};

		const result = await executePlan(plan, ctx);

		// Update sync signature after a fully successful sync
		if (result.failed.length === 0) {
			const sig = computeSignature(plan);
			if (sig !== "0") {
				try {
					// Remote first (per spec): remote write failing leaves local sig stale → full sync next time
					await writeRemoteSignature(remoteFs, this.deps.clientId, sig);
					await this.deps.saveLocalSignature(sig);
				} catch (e) {
					this.deps.logger?.warn("Failed to update sync signature", {
						error: e instanceof Error ? e.message : String(e),
					});
				}
			}
		}

		// Persist backend state
		const provider = this.deps.backendProvider();
		if (provider?.readBackendState && remoteFs) {
			const current = settings.backendData[provider.type] ?? {};
			settings.backendData[provider.type] = {
				...current,
				...provider.readBackendState(remoteFs),
			};
		}
		await this.deps.saveSettings();

		return result;
	}
}
