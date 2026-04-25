import { IDBHelper, sanitizeDbName } from "./idb-helper";

/** Per-device settings that are not synced across the group */
export interface InstanceSettings {
	/** Write sync logs to .airsync/logs/{device}/{date}.log */
	enableLogging: boolean;
	/** Minimum log level to write */
	logLevel: "debug" | "info" | "warn" | "error";
	/** Per-backend instance state keyed by backend type */
	backendInstance: Record<string, { accessTokenExpiry: number }>;
	/** Hash of the last sync pass that modified files; "0" when no sync history */
	lastSyncSignature: string;
	/** Absolute vault path on desktop; empty on mobile. Used to detect same-name vault collisions. */
	vaultPath: string;
}

export const DEFAULT_INSTANCE_SETTINGS: InstanceSettings = {
	enableLogging: false,
	logLevel: "info",
	backendInstance: {},
	lastSyncSignature: "0",
	vaultPath: "",
};

/** Per-device record stored at the fixed key "__device__" — shared across all vaults on this device */
export interface DeviceRecord {
	clientId: string;
}

/** Per-vault record stored at key "__vault__<vaultKey>" — mobile vault UUID, not synced */
export interface VaultRecord {
	vaultId: string;
}

const DEVICE_KEY = "__device__";

const STORE_NAME = "settings";

/** Compute the IDB record key for a given vault — the sanitized vault name. */
export function vaultInstanceKey(vaultName: string): string {
	return sanitizeDbName(vaultName);
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

	async loadDevice(): Promise<DeviceRecord> {
		try {
			const result = await this.idb.runTransaction(STORE_NAME, "readonly", (tx) => {
				const req = tx.objectStore(STORE_NAME).get(DEVICE_KEY);
				return () => req.result as DeviceRecord | undefined;
			});
			return result ?? { clientId: "" };
		} catch {
			return { clientId: "" };
		}
	}

	async saveDevice(record: DeviceRecord): Promise<void> {
		await this.idb.runTransaction(STORE_NAME, "readwrite", (tx) => {
			tx.objectStore(STORE_NAME).put(record, DEVICE_KEY);
			return () => undefined;
		});
	}

	async loadVaultRecord(vaultKey: string): Promise<VaultRecord> {
		const key = `__vault__${vaultKey}`;
		try {
			const result = await this.idb.runTransaction(STORE_NAME, "readonly", (tx) => {
				const req = tx.objectStore(STORE_NAME).get(key);
				return () => req.result as VaultRecord | undefined;
			});
			return result ?? { vaultId: "" };
		} catch {
			return { vaultId: "" };
		}
	}

	async saveVaultRecord(vaultKey: string, record: VaultRecord): Promise<void> {
		const key = `__vault__${vaultKey}`;
		await this.idb.runTransaction(STORE_NAME, "readwrite", (tx) => {
			tx.objectStore(STORE_NAME).put(record, key);
			return () => undefined;
		});
	}

	async close(): Promise<void> {
		await this.idb.close();
	}
}
