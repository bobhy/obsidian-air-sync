import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const AUTH_SERVER = "https://auth-smartsync.takezo.dev";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const POLL_INTERVAL_MS = 2_000;

interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	trashed?: boolean;
}

interface DriveFileList {
	files: DriveFile[];
}

interface TokenResponse {
	access_token: string;
	expires_in: number;
}

/**
 * Read a SecretStorage value from the focused Obsidian vault.
 * obsidian eval requires `code=` and outputs `=> <JS-value>`, e.g. `=> "tok"` or `=> null`.
 */
export async function evalVaultSecret(key: string): Promise<string | null> {
	const { stdout } = await execAsync(
		`obsidian eval 'code=app.secretStorage.getSecret("${key}")'`,
		{ timeout: 10_000 },
	);
	const raw = stdout.trim();
	const stripped = raw.startsWith("=> ") ? raw.slice(3) : raw;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripped);
	} catch {
		parsed = stripped;
	}
	return typeof parsed === "string" ? parsed : null;
}

// Refresh token is read once from the vault's SecretStorage via obsidian eval
let cachedRefreshToken = "";
let cachedAccessToken = "";
let accessTokenExpiry = 0;

async function getRefreshToken(): Promise<string> {
	if (cachedRefreshToken) return cachedRefreshToken;
	const token = await evalVaultSecret("air-sync-googledrive-refresh-token");
	if (!token) {
		throw new Error(
			'No GDrive refresh token in vault SecretStorage. Run "npm run setup:e2e" first.'
		);
	}
	cachedRefreshToken = token;
	return token;
}

async function getAccessToken(): Promise<string> {
	if (cachedAccessToken && Date.now() < accessTokenExpiry - 60_000) {
		return cachedAccessToken;
	}
	const refreshToken = await getRefreshToken();
	const response = await fetch(`${AUTH_SERVER}/google/token/refresh`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ refresh_token: refreshToken }),
	});
	if (!response.ok) {
		throw new Error(`Token refresh failed: ${response.status} ${await response.text()}`);
	}
	const data = await response.json() as TokenResponse;
	cachedAccessToken = data.access_token;
	accessTokenExpiry = Date.now() + data.expires_in * 1000;
	return cachedAccessToken;
}

async function findChildByName(
	parentId: string,
	name: string,
	mimeType?: string,
): Promise<DriveFile | null> {
	const token = await getAccessToken();
	const clauses = [
		`'${parentId}' in parents`,
		`name = '${name.replace(/'/g, "\\'")}'`,
		"trashed = false",
		...(mimeType ? [`mimeType = '${mimeType}'`] : []),
	];
	const params = new URLSearchParams({
		q: clauses.join(" and "),
		fields: "files(id,name,mimeType)",
		pageSize: "1",
	});
	const response = await fetch(`${DRIVE_API}/files?${params.toString()}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!response.ok) {
		throw new Error(`GDrive files list failed: ${response.status}`);
	}
	const result = await response.json() as DriveFileList;
	return result.files[0] ?? null;
}

// Drive root / obsidian-air-sync / {sanitizeDbName(vaultName)} /
function sanitizeDbName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export async function resolveVaultFolder(vaultName: string): Promise<string> {
	const root = await findChildByName("root", "obsidian-air-sync", FOLDER_MIME);
	if (!root) throw new Error("obsidian-air-sync folder not found in GDrive root");
	const vault = await findChildByName(root.id, sanitizeDbName(vaultName), FOLDER_MIME);
	if (!vault) throw new Error(`Vault folder "${sanitizeDbName(vaultName)}" not found in GDrive`);
	return vault.id;
}

function sleep(ms: number): Promise<void> {
	return new Promise<void>((r) => setTimeout(r, ms));
}

export async function pollForFile(
	folderId: string,
	filename: string,
	timeoutMs = 30_000,
): Promise<DriveFile> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const file = await findChildByName(folderId, filename);
		if (file) return file;
		await sleep(POLL_INTERVAL_MS);
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for "${filename}" in GDrive`);
}

export async function pollForFileGone(
	fileId: string,
	timeoutMs = 30_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const token = await getAccessToken();
		const response = await fetch(
			`${DRIVE_API}/files/${fileId}?fields=id,trashed`,
			{ headers: { Authorization: `Bearer ${token}` } },
		);
		if (response.status === 404) return;
		if (response.ok) {
			const file = await response.json() as DriveFile;
			if (file.trashed) return;
		}
		await sleep(POLL_INTERVAL_MS);
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for file ${fileId} to be removed from GDrive`);
}
