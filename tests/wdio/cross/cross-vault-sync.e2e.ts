import { browser, expect } from "@wdio/globals";
import { before, describe, it, afterEach } from "mocha";
import { resolveVaultFolder, pollForFile, pollForFileGone } from "../helpers/gdrive.js";

const DRIVE_FOLDER_NAME = "air-sync-e2e";

let vaultFolderId: string;

// In multiremote mode, browser is a MultiRemoteBrowser. Access instances by name.
function primary(): WebdriverIO.Browser {
	return (browser as unknown as WebdriverIO.MultiRemoteBrowser).getInstance("primaryVault");
}
function peer(): WebdriverIO.Browser {
	return (browser as unknown as WebdriverIO.MultiRemoteBrowser).getInstance("peerVault");
}

type VaultCtx = {
	app: {
		vault: {
			create(name: string, content: string): Promise<unknown>;
			getMarkdownFiles(): Array<{ name: string }>;
			delete(file: unknown): Promise<void>;
			getAbstractFileByPath(path: string): unknown;
		};
		secretStorage: { setSecret(key: string, value: string): Promise<void> };
		plugins: { plugins: Record<string, unknown> };
	};
	plugins: Record<string, unknown>;
	obsidian: Record<string, unknown>;
};

type PluginWithBackend = {
	backendManager?: { getRemoteFs(): unknown; initBackend(): Promise<void> };
};

// wdio-obsidian-service's before() exits early in multiremote mode because the combined
// capabilities object lacks OBSIDIAN_CAPABILITY_KEY at the top level, so executeObsidian
// is never registered on individual instances. Replicate the same invocation pattern via
// br.execute(), mirroring the executeObsidian implementation exactly.
function execVault<T>(
	br: WebdriverIO.Browser,
	script: (ctx: VaultCtx, ...args: unknown[]) => T | Promise<T>,
	...params: unknown[]
): Promise<T> {
	return br.execute(
		`try {
			return await (${script.toString()}).call(null, window.wdioObsidianService(), ...arguments);
		} catch (e) {
			if (e && 'code' in e && typeof e.code !== 'number') { delete e.code; }
			throw e;
		}`,
		...params,
	) as Promise<T>;
}

before(async () => {
	const refreshToken = process.env["AIRSYNC_REFRESH_TOKEN"]!;

	// Wait for Obsidian to launch and the air-sync plugin to be loaded in both vaults.
	// Two simultaneous Obsidian instances can be slow — log diagnostics each poll so we
	// can distinguish "Obsidian still loading" from "plugin missing" if it times out.
	const waitForPlugin = async (b: WebdriverIO.Browser, name: string) => {
		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline) {
			type PluginState = {
				hasWindowApp: boolean; hasSvc: boolean; svcPluginKeys: string[];
				hasRequire: boolean; windowAppKeys: string[];
			};
			const state = await b.execute(`
				const a = window.app;
				const svc = typeof window.wdioObsidianService === 'function' ? window.wdioObsidianService() : null;
				const svcApp = svc ? svc.app : null;
				return {
					hasWindowApp: !!a,
					hasSvc: !!svc,
					svcPluginKeys: (svcApp && svcApp.plugins && svcApp.plugins.plugins)
						? Object.keys(svcApp.plugins.plugins) : [],
					hasRequire: typeof require !== 'undefined',
					windowAppKeys: a && a.plugins && a.plugins.plugins
						? Object.keys(a.plugins.plugins) : [],
				};
			`) as PluginState;
			console.log(`[${name}] windowApp=${state.hasWindowApp} wdioSvc=${state.hasSvc} svcKeys=[${state.svcPluginKeys.join(",")}] require=${state.hasRequire} appKeys=[${state.windowAppKeys.join(",")}]`);
			if (state.hasSvc && state.svcPluginKeys.includes("air-sync")) break;
			await new Promise<void>(r => setTimeout(r, 5_000));
		}
		if (Date.now() >= deadline) throw new Error(`${name} air-sync plugin not ready after 120s`);
		// Mirror what prepareApp() does in single-vault: wait for the workspace layout to be ready.
		await b.waitUntil(
			() => b.execute(`return window.app.workspace.layoutReady === true`),
			{ timeout: 30_000, interval: 500, timeoutMsg: `${name} workspace layout not ready` },
		);
	};
	await Promise.all([waitForPlugin(primary(), "primaryVault"), waitForPlugin(peer(), "peerVault")]);

	// Inject token and initialize backend in both vaults.
	await Promise.all([
		execVault(primary(), async (ctx, token) => {
			await ctx.app.secretStorage.setSecret("air-sync-googledrive-refresh-token", token as string);
			const plugin = ctx.plugins["airSync"] as unknown as PluginWithBackend;
			await plugin?.backendManager?.initBackend();
		}, refreshToken),
		execVault(peer(), async (ctx, token) => {
			await ctx.app.secretStorage.setSecret("air-sync-googledrive-refresh-token", token as string);
			const plugin = ctx.plugins["airSync"] as unknown as PluginWithBackend;
			await plugin?.backendManager?.initBackend();
		}, refreshToken),
	]);

	// Wait for both backends to be ready.
	await Promise.all([
		primary().waitUntil(
			() => execVault(primary(), (ctx) =>
				!!(ctx.plugins["airSync"] as unknown as PluginWithBackend)?.backendManager?.getRemoteFs(),
			),
			{ timeout: 60_000, interval: 1_000, timeoutMsg: "primaryVault backend not ready after 60s" },
		),
		peer().waitUntil(
			() => execVault(peer(), (ctx) =>
				!!(ctx.plugins["airSync"] as unknown as PluginWithBackend)?.backendManager?.getRemoteFs(),
			),
			{ timeout: 60_000, interval: 1_000, timeoutMsg: "peerVault backend not ready after 60s" },
		),
	]);

	vaultFolderId = await resolveVaultFolder(DRIVE_FOLDER_NAME);
});

// Remove any stale e2e-cross-* trigger notes left by aborted test runs.
afterEach(async () => {
	await execVault(primary(), async (ctx) => {
		for (const f of ctx.app.vault.getMarkdownFiles()) {
			if (/^e2e-cross-/.test(f.name) || f.name === "sync-trigger.md") {
				await ctx.app.vault.delete(f);
			}
		}
	});
	await execVault(peer(), async (ctx) => {
		for (const f of ctx.app.vault.getMarkdownFiles()) {
			if (/^e2e-cross-/.test(f.name) || f.name === "sync-trigger.md") {
				await ctx.app.vault.delete(f);
			}
		}
	});
});

// Wait for a file to appear in a vault instance.
function waitForVaultFile(b: WebdriverIO.Browser, filename: string, timeoutMs = 60_000) {
	return b.waitUntil(
		() => execVault(b, (ctx, fn) => ctx.app.vault.getAbstractFileByPath(fn as string) !== null, filename),
		{ timeout: timeoutMs, interval: 2_000, timeoutMsg: `Timed out waiting for "${filename}" in vault` },
	);
}

// Wait for a file to disappear from a vault instance.
function waitForVaultFileGone(b: WebdriverIO.Browser, filename: string, timeoutMs = 60_000) {
	return b.waitUntil(
		() => execVault(b, (ctx, fn) => ctx.app.vault.getAbstractFileByPath(fn as string) === null, filename),
		{ timeout: timeoutMs, interval: 2_000, timeoutMsg: `Timed out waiting for "${filename}" to leave vault` },
	);
}

// Kick off a sync in a vault by creating (or recreating) a throw-away note. The vault.on('create')
// event triggers debouncedSync(), which also pulls pending remote changes.
function triggerSync(b: WebdriverIO.Browser) {
	return execVault(b, async (ctx) => {
		const existing = ctx.app.vault.getAbstractFileByPath("sync-trigger.md");
		if (existing) await ctx.app.vault.delete(existing);
		await ctx.app.vault.create("sync-trigger.md", "");
	});
}

describe("cross-vault sync", () => {
	it("syncs a new note from vault 1 to vault 2 via Drive", async () => {
		const filename = `e2e-cross-create-${Date.now()}.md`;

		await execVault(primary(), async (ctx, fn) => {
			await ctx.app.vault.create(fn as string, "");
		}, filename);

		const driveFile = await pollForFile(vaultFolderId, filename, 60_000);
		expect(driveFile.name).toBe(filename);

		// Trigger a sync in the peer vault to pull the new file down from Drive.
		await triggerSync(peer());
		await waitForVaultFile(peer(), filename);
	});

	it("deletes a note from vault 1 and removes it from vault 2 via Drive", async () => {
		const filename = `e2e-cross-delete1-${Date.now()}.md`;

		// Setup: create in primary, verify in Drive, pull into peer.
		await execVault(primary(), async (ctx, fn) => {
			await ctx.app.vault.create(fn as string, "");
		}, filename);
		const driveFile = await pollForFile(vaultFolderId, filename, 60_000);
		await triggerSync(peer());
		await waitForVaultFile(peer(), filename);

		// Delete from primary. vault.on('delete') → debouncedSync() → Drive deletion.
		await execVault(primary(), async (ctx, fn) => {
			const f = ctx.app.vault.getAbstractFileByPath(fn as string);
			if (f) await ctx.app.vault.delete(f);
		}, filename);
		await pollForFileGone(driveFile.id, 60_000);

		// Trigger sync in peer to pull the deletion.
		await triggerSync(peer());
		await waitForVaultFileGone(peer(), filename);
	});

	it("deletes a note from vault 2 and removes it from vault 1 via Drive", async () => {
		const filename = `e2e-cross-delete2-${Date.now()}.md`;

		// Setup: create in primary, verify in Drive, pull into peer.
		await execVault(primary(), async (ctx, fn) => {
			await ctx.app.vault.create(fn as string, "");
		}, filename);
		const driveFile = await pollForFile(vaultFolderId, filename, 60_000);
		await triggerSync(peer());
		await waitForVaultFile(peer(), filename);

		// Delete from peer. vault.on('delete') → debouncedSync() → Drive deletion.
		await execVault(peer(), async (ctx, fn) => {
			const f = ctx.app.vault.getAbstractFileByPath(fn as string);
			if (f) await ctx.app.vault.delete(f);
		}, filename);
		await pollForFileGone(driveFile.id, 60_000);

		// Trigger sync in primary to pull the deletion. Drive's changes.list can lag
		// behind files.get visibility, so re-trigger every 10s until the file is gone.
		await triggerSync(primary());
		const syncDeadline = Date.now() + 90_000;
		while (true) {
			const gone = await execVault(primary(), (ctx, fn) =>
				ctx.app.vault.getAbstractFileByPath(fn as string) === null, filename);
			if (gone) break;
			if (Date.now() >= syncDeadline)
				throw new Error(`Timed out waiting for "${filename}" to leave primary vault`);
			await new Promise<void>(r => setTimeout(r, 10_000));
			await triggerSync(primary());
		}
	});
});
