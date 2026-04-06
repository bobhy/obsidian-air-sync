import { IDBHelper, sanitizeDbName } from "./idb-helper";

/** Per-device settings that are not synced across the group */
export interface InstanceSettings {
	/** Unique identifier for this device/install */
	vaultId: string;
	/** Write sync logs to .airsync/logs/{device}/{date}.log */
	enableLogging: boolean;
	/** Minimum log level to write */
	logLevel: "debug" | "info" | "warn" | "error";
	/** Per-backend instance state keyed by backend type */
	backendInstance: Record<string, { accessTokenExpiry: number }>;
}

export const DEFAULT_INSTANCE_SETTINGS: InstanceSettings = {
	vaultId: "",
	enableLogging: false,
	logLevel: "info",
	backendInstance: {},
};

const STORE_NAME = "settings";

/**
 * Compute the IDB record key for a given vault.
 * Uses vault name + configDir so the key survives vault path moves but stays
 * unique per vault when multiple vaults share the same Obsidian installation.
 */
export function vaultInstanceKey(vaultName: string, configDir: string): string {
	return sanitizeDbName(`${vaultName}_${configDir}`);
}

/**
 * Persists per-device settings in IndexedDB (not in settings.json).
 * Stored in Obsidian's app-data directory, never touched by vault sync.
 * Each vault gets its own record, keyed by vaultInstanceKey().
 */
export class InstanceStore {
	private idb: IDBHelper;

	constructor() {
		this.idb = new IDBHelper({
			dbName: "air-sync-instance",
			version: 1,
			onUpgrade: (db) => {
				// Cold-start on schema change: drop all stores and recreate
				for (const name of Array.from(db.objectStoreNames)) {
					db.deleteObjectStore(name);
				}
				db.createObjectStore(STORE_NAME);
			},
		});
	}

	async load(vaultKey: string): Promise<InstanceSettings> {
		try {
			const result = await this.idb.runTransaction(STORE_NAME, "readonly", (tx) => {
				const req = tx.objectStore(STORE_NAME).get(vaultKey);
				return () => req.result as InstanceSettings | undefined;
			});
			return { ...DEFAULT_INSTANCE_SETTINGS, ...result };
		} catch {
			return { ...DEFAULT_INSTANCE_SETTINGS };
		}
	}

	async save(vaultKey: string, data: InstanceSettings): Promise<void> {
		await this.idb.runTransaction(STORE_NAME, "readwrite", (tx) => {
			tx.objectStore(STORE_NAME).put(data, vaultKey);
			return () => undefined;
		});
	}

	async close(): Promise<void> {
		await this.idb.close();
	}
}
