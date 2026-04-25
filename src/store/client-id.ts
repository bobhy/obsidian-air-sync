import { sanitizeDbName } from "./idb-helper";
import type { InstanceStore } from "./instance-store";

/**
 * Resolve the client ID for this device+vault combination.
 *
 * Format:
 *   Desktop (hostname available):  <hostname>_<vaultSuffix>
 *   Mobile / no hostname:          Client_<deviceUUID>_<vaultSuffix>
 *
 * vaultSuffix:
 *   Desktop (vaultPath non-empty): first 8 hex chars of SHA-256(vaultPath)
 *   Mobile  (vaultPath empty):     UUID stored per-vault in IDB
 */
export async function resolveClientId(
	instanceStore: InstanceStore,
	vaultKey: string,
	vaultPath: string,
): Promise<string> {
	const deviceId = await resolveDeviceId(instanceStore);
	const suffix = await resolveVaultSuffix(instanceStore, vaultKey, vaultPath);
	return `${deviceId}_${suffix}`;
}

async function resolveDeviceId(instanceStore: InstanceStore): Promise<string> {
	const hostname = tryGetHostname();
	if (hostname) return sanitizeDbName(hostname);

	const device = await instanceStore.loadDevice();
	if (device.clientId) return device.clientId;

	const generated = `Client_${crypto.randomUUID()}`;
	await instanceStore.saveDevice({ clientId: generated });
	return generated;
}

async function resolveVaultSuffix(
	instanceStore: InstanceStore,
	vaultKey: string,
	vaultPath: string,
): Promise<string> {
	if (vaultPath) return shortHash(vaultPath);

	const vault = await instanceStore.loadVaultRecord(vaultKey);
	if (vault.vaultId) return vault.vaultId;

	const generated = crypto.randomUUID();
	await instanceStore.saveVaultRecord(vaultKey, { vaultId: generated });
	return generated;
}

async function shortHash(input: string): Promise<string> {
	const encoded = new TextEncoder().encode(input);
	const buf = await crypto.subtle.digest("SHA-256", encoded);
	return Array.from(new Uint8Array(buf))
		.slice(0, 4)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function tryGetHostname(): string | null {
	if (process.env.HOSTNAME) return process.env.HOSTNAME;

	try {
		const g = globalThis as unknown as { require?: (id: string) => unknown };
		const os = g.require?.("os") as { hostname?: () => string } | undefined;
		return os?.hostname?.() ?? null;
	} catch {
		return null;
	}
}
