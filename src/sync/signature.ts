import type { SyncPlan } from "./types";
import type { IFileSystem } from "../fs/interface";
import { AIRSYNC_DIR } from "../constants";

function djb2(input: string): number {
	let hash = 5381;
	for (let i = 0; i < input.length; i++) {
		hash = ((hash << 5) + hash) + input.charCodeAt(i);
		hash = hash & hash;
	}
	return hash >>> 0;
}

/**
 * Compute a sync signature from a plan.
 * Returns "0" if no modifying actions (nothing changed).
 * Modifying actions are all action types except "match".
 */
export function computeSignature(plan: SyncPlan): string {
	const modifying = plan.actions.filter((a) => a.action !== "match");
	if (modifying.length === 0) return "0";
	const sorted = modifying
		.map((a) => `${a.path}:${a.action}`)
		.sort();
	return String(djb2(sorted.join("|")));
}

/**
 * Read the last sync signature for this client from the remote vault.
 * Returns "0" if the file does not exist or cannot be parsed.
 */
export async function readRemoteSignature(
	remoteFs: IFileSystem,
	clientId: string,
): Promise<string> {
	const path = `${AIRSYNC_DIR}/${clientId}.json`;
	try {
		const content = await remoteFs.read(path);
		const text = new TextDecoder().decode(content);
		const parsed = JSON.parse(text) as { lastSyncSignature?: unknown };
		if (typeof parsed.lastSyncSignature === "string") return parsed.lastSyncSignature;
	} catch {
		// file not found or parse error — treat as absent
	}
	return "0";
}

/**
 * Write the last sync signature for this client to the remote vault.
 * Stored at .airsync/<clientId>.json.
 */
export async function writeRemoteSignature(
	remoteFs: IFileSystem,
	clientId: string,
	signature: string,
): Promise<void> {
	const path = `${AIRSYNC_DIR}/${clientId}.json`;
	const bytes = new TextEncoder().encode(JSON.stringify({ lastSyncSignature: signature }));
	await remoteFs.write(path, bytes.buffer as ArrayBuffer, Date.now());
}
