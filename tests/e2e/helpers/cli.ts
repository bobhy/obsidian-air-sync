import { exec } from "node:child_process";
import { promisify } from "node:util";
import { VAULT_NAME } from "./env.js";

const execAsync = promisify(exec);

async function run(args: string): Promise<string> {
	const { stdout, stderr } = await execAsync(`obsidian ${args}`, { timeout: 15_000 });
	if (stderr) process.stderr.write(stderr);
	return stdout.trim();
}

export async function openVault(): Promise<void> {
	await run(`vault=${VAULT_NAME}`);
	await new Promise<void>((r) => setTimeout(r, 3_000));
}

export async function createNote(name: string): Promise<void> {
	await run(`create name="${name}"`);
}
