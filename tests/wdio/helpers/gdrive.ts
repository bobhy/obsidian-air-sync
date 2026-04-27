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
	nextPageToken?: string;
}

interface TokenResponse {
	access_token: string;
	expires_in: number;
}

// Set by the wdio.conf.mts `before` hook via browser.executeObsidian on the vault's secretStorage.
function getRefreshToken(): string {
	const token = process.env["AIRSYNC_REFRESH_TOKEN"];
	if (!token) throw new Error("No GDrive refresh token in env. Check the wdio config before hook.");
	return token;
}

let cachedAccessToken = "";
let accessTokenExpiry = 0;

async function getAccessToken(): Promise<string> {
	if (cachedAccessToken && Date.now() < accessTokenExpiry - 60_000) {
		return cachedAccessToken;
	}
	const refreshToken = getRefreshToken();
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

export async function pollForFile(
	folderId: string,
	filename: string,
	timeoutMs = 30_000,
): Promise<DriveFile> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const file = await findChildByName(folderId, filename);
		if (file) return file;
		await new Promise<void>(r => setTimeout(r, POLL_INTERVAL_MS));
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for "${filename}" in GDrive`);
}

export async function pollForFileGone(fileId: string, timeoutMs = 30_000): Promise<void> {
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
		await new Promise<void>(r => setTimeout(r, POLL_INTERVAL_MS));
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for Drive file ${fileId} to be removed`);
}

export async function pollForFileContent(
	fileId: string,
	expectedText: string,
	timeoutMs = 30_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const token = await getAccessToken();
		const response = await fetch(
			`${DRIVE_API}/files/${fileId}?alt=media`,
			{ headers: { Authorization: `Bearer ${token}` } },
		);
		if (response.ok) {
			const text = await response.text();
			if (text.includes(expectedText)) return;
		}
		await new Promise<void>(r => setTimeout(r, POLL_INTERVAL_MS));
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for Drive file ${fileId} to contain "${expectedText}"`);
}

export async function deleteFile(fileId: string): Promise<void> {
	const token = await getAccessToken();
	const response = await fetch(`${DRIVE_API}/files/${fileId}`, {
		method: "DELETE",
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!response.ok && response.status !== 404) {
		throw new Error(`GDrive delete failed: ${response.status} for file ${fileId}`);
	}
}

export async function deleteStaleTestFiles(folderId: string, prefix: string): Promise<void> {
	const token = await getAccessToken();
	const params = new URLSearchParams({
		q: `'${folderId}' in parents and name contains '${prefix}' and trashed = false`,
		fields: "files(id,name)",
		pageSize: "1000",
	});
	const response = await fetch(`${DRIVE_API}/files?${params.toString()}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!response.ok) throw new Error(`GDrive list failed: ${response.status}`);
	const result = await response.json() as DriveFileList;
	await Promise.all(result.files.map(f => deleteFile(f.id)));
}
