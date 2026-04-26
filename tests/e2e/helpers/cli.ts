import { exec } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { VAULT_NAME, PEER_VAULT_NAME } from "./env.js";

const execAsync = promisify(exec);

export function sleep(ms: number): Promise<void> {
	return new Promise<void>((r) => setTimeout(r, ms));
}

async function run(args: string): Promise<string> {
	const { stdout, stderr } = await execAsync(`obsidian ${args}`, { timeout: 15_000 });
	if (stderr) process.stderr.write(stderr);
	return stdout.trim();
}

export async function openVault(): Promise<void> {
	await run(`vault=${VAULT_NAME}`);
	// Allow initBackend() (including resolveRemoteVault Drive API calls) to finish
	// before callers fire sync triggers. 3 s is not enough; 8 s gives comfortable margin.
	await sleep(8_000);
}

export async function openPeerVault(): Promise<void> {
	await run(`vault=${PEER_VAULT_NAME}`);
	await sleep(8_000);
}

export async function createNote(name: string): Promise<void> {
	await run(`create name="${name}"`);
}

/**
 * Create a throwaway note in the currently active vault. The vault `create`
 * event fires immediately and schedules the debounced sync (5 s), which also
 * pulls any pending remote changes — replicating what a real user would do
 * when they open a vault and start working.
 */
export async function triggerSync(): Promise<void> {
	await run(`create name="e2e-sync-trigger-${Date.now()}"`);
}

export async function pollForLocalFile(
	vaultPath: string,
	filename: string,
	timeoutMs = 60_000,
): Promise<void> {
	const filepath = join(vaultPath, filename);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await access(filepath);
			return;
		} catch {
			await sleep(2_000);
		}
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for "${filename}" to appear in ${vaultPath}`);
}

export async function pollForLocalFileGone(
	vaultPath: string,
	filename: string,
	timeoutMs = 60_000,
): Promise<void> {
	const filepath = join(vaultPath, filename);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await access(filepath);
			await sleep(2_000);
		} catch {
			return;
		}
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for "${filename}" to disappear from ${vaultPath}`);
}
