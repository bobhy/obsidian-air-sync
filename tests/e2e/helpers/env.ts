import * as os from "node:os";
import * as path from "node:path";

export const E2E_ROOT: string =
	process.env["OBSIDIAN-E2E-ROOT"] ?? path.join(os.homedir(), "obsidian-test");

export const VAULT_NAME = "air-sync-e2e";

export const VAULT_PATH = path.join(E2E_ROOT, VAULT_NAME);

export function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Required env var ${name} is not set`);
	return value;
}
