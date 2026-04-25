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
	const hostname = tryGetHostname();
	if (hostname) return sanitizeDbName(hostname);

	const device = await instanceStore.loadDevice();
	if (device.clientId) return device.clientId;

	const generated = `Client_${crypto.randomUUID()}`;
	await instanceStore.saveDevice({ clientId: generated });
	return generated;
}

function tryGetHostname(): string | null {
	// process.env.HOSTNAME is set by most Linux shells and available in Electron.
	if (process.env.HOSTNAME) return process.env.HOSTNAME;

	// Electron exposes require on the global object; more reliable than dynamic import()
	// in the renderer process. Not typed in ESM, so we access it via globalThis/unknown.
	try {
		const g = globalThis as unknown as { require?: (id: string) => unknown };
		const os = g.require?.("os") as { hostname?: () => string } | undefined;
		return os?.hostname?.() ?? null;
	} catch {
		return null;
	}
}
