import type { ConflictStrategy } from "./sync/types";

export interface AirSyncSettings {
	/** Selected backend type (e.g. "googledrive") */
	backendType: string;
	/** Strategy for conflict resolution */
	conflictStrategy: ConflictStrategy;
	/** Gitignore-style patterns to exclude from sync */
	ignorePatterns: string[];
	/** Enable 3-way merge for text files */
	enableThreeWayMerge: boolean;
	/** Dot-prefixed paths to include in sync (e.g. [".templates", ".stversions"]) */
	syncDotPaths: string[];
	/** Maximum file size in MB to sync on mobile */
	mobileMaxFileSizeMB: number;

	/** Write sync logs to .airsync/logs/{device}/{date}.log */
	enableLogging: boolean;
	/** Minimum log level to write */
	logLevel: "debug" | "info" | "warn" | "error";

	/** Backend-specific data, keyed by backend type (e.g. "googledrive") */
	backendData: Record<string, Record<string, unknown>>;
}

export const DEFAULT_SETTINGS: AirSyncSettings = {
	backendType: "googledrive",
	conflictStrategy: "auto_merge",
	ignorePatterns: [],
	syncDotPaths: [],
	enableThreeWayMerge: true,
	mobileMaxFileSizeMB: 10,
	enableLogging: false,
	logLevel: "info",
	backendData: {},
};

/**
 * The subset of AirSyncSettings written to settings.json (and thus synced across devices).
 * AirSyncSettings serves as the single in-memory runtime type to avoid touching every
 * call site; SyncableSettings is only used at the persistence boundary (saveData).
 */
export type SyncableSettings = Omit<AirSyncSettings, "enableLogging" | "logLevel">;

/** Backend fields that are per-device — stripped from backendData before writing to settings.json */
const INSTANCE_BACKEND_KEYS = [
	"accessTokenExpiry",
	"changesStartPageToken", // legacy: removed from backendData, kept here to clean up old values
	"pendingAuthState",      // legacy: removed from backendData, kept here to clean up old values
	"pendingCodeVerifier",   // legacy: removed from backendData, kept here to clean up old values
] as const;

/** Return a copy of settings with instance-specific fields removed, safe to write to settings.json */
export function toSyncable(settings: AirSyncSettings): SyncableSettings {
	const backendData: Record<string, Record<string, unknown>> = {};
	for (const [type, data] of Object.entries(settings.backendData)) {
		const cleaned = { ...data };
		for (const key of INSTANCE_BACKEND_KEYS) {
			delete cleaned[key];
		}
		backendData[type] = cleaned;
	}
	// Spread all settings then override backendData; the return type drops instance-only keys
	return { ...settings, backendData } as unknown as SyncableSettings;
}

