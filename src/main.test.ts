import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";
import { App, type PluginManifest } from "obsidian";
import AirSyncPlugin from "./main";

// Mock modules only used in onload() — not needed for loadSettings/saveSettings tests
vi.mock("./ui/settings", () => ({ AirSyncSettingTab: class {} }));
vi.mock("./ui/join-conflict-modal", () => ({ JoinConflictModal: class {} }));
vi.mock("./fs/local/index", () => ({ LocalFs: class {} }));
vi.mock("./fs/backend-manager", () => ({
	BackendManager: class {
		initBackend = vi.fn().mockResolvedValue(undefined);
		getRemoteFs = vi.fn().mockReturnValue(null);
		getBackendProvider = vi.fn().mockReturnValue(null);
		isConnecting = vi.fn().mockReturnValue(false);
		close = vi.fn();
		completeBackendConnect = vi.fn();
	},
}));
vi.mock("./fs/registry", () => ({ initRegistry: vi.fn() }));
vi.mock("./sync/orchestrator", () => ({
	SyncOrchestrator: class {
		state = {};
		isSyncing = vi.fn().mockReturnValue(false);
		isExcluded = vi.fn().mockReturnValue(false);
		hasSyncHistory = vi.fn().mockResolvedValue(false);
		clearSyncState = vi.fn().mockResolvedValue(undefined);
		close = vi.fn().mockResolvedValue(undefined);
	},
}));
vi.mock("./sync/scheduler", () => ({
	SyncScheduler: class {
		start = vi.fn();
		destroy = vi.fn();
	},
}));
vi.mock("./sync/local-tracker", () => ({ LocalChangeTracker: class {} }));
vi.mock("./logging/logger", () => ({
	Logger: class { info = vi.fn(); warn = vi.fn(); error = vi.fn(); debug = vi.fn(); flush = vi.fn(); dispose = vi.fn(); },
	getDeviceName: () => "test-device",
}));

/**
 * Build a minimal plugin suitable for testing loadSettings/saveSettings in isolation.
 * Each call gets a unique vault key so IDB state never leaks between tests.
 * The returned `plugin.saveData` and `plugin.loadData` are vi.fn() mocks; the
 * `roundtrip()` helper wires them together so a save/reload cycle can be simulated.
 */
function makePlugin(opts: { manifestDir?: string } = {}): {
	plugin: AirSyncPlugin;
	manifest: PluginManifest;
	roundtrip: () => void;
} {
	const app = new App();
	// Unique vault name → unique IDB key → no cross-test interference
	const uid = Math.random().toString(36).slice(2);
	app.vault.getName = () => uid;

	const manifest: PluginManifest = {
		id: "air-sync",
		name: "Air Sync",
		version: "0.0.0",
		minAppVersion: "1.11.4",
		author: "test",
		description: "test",
		dir: opts.manifestDir ?? `.plugins/test-plugin-${uid}`,
	};

	const plugin = new AirSyncPlugin(
		app as unknown as Parameters<typeof AirSyncPlugin["prototype"]["loadData"]>[never],
		manifest,
	);

	let stored: unknown = null;
	plugin.saveData = vi.fn().mockImplementation(async (data: unknown) => { stored = data; });
	plugin.loadData = vi.fn().mockImplementation(async () => stored);

	// Call roundtrip() after saving to make the next loadData return what was last saved
	const roundtrip = () => { /* stored is already updated by saveData mock */ };

	return { plugin, manifest, roundtrip };
}

type OrchestratorSpy = { clearSyncState: ReturnType<typeof vi.fn> };

/**
 * Build a plugin suitable for testing the full onload() path.
 * Wires up secretStorage (not in the base App mock) and unique vault name.
 */
function makeOnloadPlugin(): AirSyncPlugin {
	const app = new App();
	const uid = Math.random().toString(36).slice(2);
	app.vault.getName = () => uid;
	(app as unknown as { secretStorage: { getSecret: () => Promise<null>; setSecret: () => void } }).secretStorage = {
		getSecret: () => Promise.resolve(null),
		setSecret: () => {},
	};

	const manifest: PluginManifest = {
		id: "air-sync",
		name: "Air Sync",
		version: "0.0.0",
		minAppVersion: "1.11.4",
		author: "test",
		description: "test",
		dir: `.plugins/test-plugin-${uid}`,
	};

	return new AirSyncPlugin(
		app as unknown as Parameters<typeof AirSyncPlugin["prototype"]["loadData"]>[never],
		manifest,
	);
}

describe("AirSyncPlugin — reinstall detection", () => {
	it("clears sync state when loadData returns null (reinstall scenario)", async () => {
		const plugin = makeOnloadPlugin();
		plugin.loadData = vi.fn().mockResolvedValue(null);
		plugin.saveData = vi.fn().mockResolvedValue(undefined);

		await plugin.onload();

		const orchestrator = (plugin as unknown as { orchestrator: OrchestratorSpy }).orchestrator;
		expect(orchestrator.clearSyncState).toHaveBeenCalledOnce();
	});

	it("does not clear sync state when loadData returns stored settings", async () => {
		const plugin = makeOnloadPlugin();
		plugin.loadData = vi.fn().mockResolvedValue({ syncDotPaths: [".templates"] });
		plugin.saveData = vi.fn().mockResolvedValue(undefined);

		await plugin.onload();

		const orchestrator = (plugin as unknown as { orchestrator: OrchestratorSpy }).orchestrator;
		expect(orchestrator.clearSyncState).not.toHaveBeenCalled();
	});
});

describe("AirSyncPlugin — loadSettings / saveSettings", () => {
	describe("syncDotPaths defaults", () => {
		it("includes manifest.dir on a fresh install (no stored data)", async () => {
			const { plugin, manifest } = makePlugin();
			plugin.loadData = vi.fn().mockResolvedValue(null);

			await plugin.loadSettings();

			expect(plugin.settings.syncDotPaths).toContain(manifest.dir);
		});

		it("prepends manifest.dir when stored syncDotPaths does not contain it", async () => {
			const { plugin, manifest } = makePlugin();
			plugin.loadData = vi.fn().mockResolvedValue({ syncDotPaths: [".templates"] });

			await plugin.loadSettings();

			expect(plugin.settings.syncDotPaths).toContain(manifest.dir);
			expect(plugin.settings.syncDotPaths).toContain(".templates");
		});

		it("does not duplicate manifest.dir when already present", async () => {
			const { plugin, manifest } = makePlugin();
			plugin.loadData = vi.fn().mockResolvedValue({
				syncDotPaths: [manifest.dir, ".templates"],
			});

			await plugin.loadSettings();

			const occurrences = plugin.settings.syncDotPaths.filter((p) => p === manifest.dir).length;
			expect(occurrences).toBe(1);
		});
	});

	describe("user syncDotPaths changes persist", () => {
		it("user-added path survives a save → reload cycle", async () => {
			const { plugin, manifest } = makePlugin();
			// Simulate a storage layer: saveData captures, loadData returns what was saved
			let stored: unknown = null;
			plugin.saveData = vi.fn().mockImplementation(async (d: unknown) => { stored = d; });
			plugin.loadData = vi.fn().mockImplementation(async () => stored);

			// First load — fresh install; manifest.dir gets added automatically
			await plugin.loadSettings();
			expect(plugin.settings.syncDotPaths).toContain(manifest.dir);

			// User adds a custom dot-path
			plugin.settings.syncDotPaths = [...plugin.settings.syncDotPaths, ".stversions"];
			await plugin.saveSettings();

			// Reload (simulates plugin restart or reloadSettings() call)
			await plugin.loadSettings();

			expect(plugin.settings.syncDotPaths).toContain(manifest.dir);
			expect(plugin.settings.syncDotPaths).toContain(".stversions");
		});

		it("manifest.dir is re-added if user removes it, preserving other paths", async () => {
			const { plugin, manifest } = makePlugin();
			let stored: unknown = null;
			plugin.saveData = vi.fn().mockImplementation(async (d: unknown) => { stored = d; });
			plugin.loadData = vi.fn().mockImplementation(async () => stored);

			// First load
			await plugin.loadSettings();

			// User removes manifest.dir but keeps a custom path
			plugin.settings.syncDotPaths = [".templates"];
			await plugin.saveSettings();

			// Reload — loadSettings should re-insert manifest.dir
			await plugin.loadSettings();

			expect(plugin.settings.syncDotPaths).toContain(manifest.dir);
			expect(plugin.settings.syncDotPaths).toContain(".templates");
		});

		it("manifest.dir is not duplicated across multiple reload cycles", async () => {
			const { plugin, manifest } = makePlugin();
			let stored: unknown = null;
			plugin.saveData = vi.fn().mockImplementation(async (d: unknown) => { stored = d; });
			plugin.loadData = vi.fn().mockImplementation(async () => stored);

			await plugin.loadSettings();
			await plugin.loadSettings();
			await plugin.loadSettings();

			const occurrences = plugin.settings.syncDotPaths.filter((p) => p === manifest.dir).length;
			expect(occurrences).toBe(1);
		});
	});
});
