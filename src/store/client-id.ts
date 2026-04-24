import { sanitizeDbName } from "./idb-helper";
import type { InstanceStore } from "./instance-store";

/**
 * Resolve the client ID for this device.
 *
 * On Electron desktop, uses the OS hostname (stable, human-readable).
 * On mobile or when the hostname API is unavailable, falls back to a UUID
 * persisted at the fixed key "__device__" in InstanceStore so all vault
 * instances on the same device share the same ID.
 */
export async function resolveClientId(instanceStore: InstanceStore): Promise<string> {
	const hostname = await tryGetHostname();
	if (hostname) return sanitizeDbName(hostname);

	const device = await instanceStore.loadDevice();
	if (device.clientId) return device.clientId;

	const generated = `Client_${crypto.randomUUID()}`;
	await instanceStore.saveDevice({ clientId: generated });
	return generated;
}

async function tryGetHostname(): Promise<string | null> {
	try {
		// eslint-disable-next-line import/no-nodejs-modules -- intentional: Electron-only, mobile throws and we fall back to UUID
		const os = await import("os");
		const name = os.hostname();
		return name || null;
	} catch {
		return null;
	}
}
