import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";
import { App, type PluginManifest } from "obsidian";
import AirSyncPlugin from "./main";

// Mock modules only used in onload() — not needed for loadSettings/saveSettings tests
vi.mock("./ui/settings", () => ({ AirSyncSettingTab: class {} }));
vi.mock("./ui/join-conflict-modal", () => ({ JoinConflictModal: class {} }));
vi.mock("./fs/local/index", () => ({ LocalFs: class {} }));
vi.mock("./fs/backend-manager", () => ({ BackendManager: class {} }));
vi.mock("./fs/registry", () => ({ initRegistry: vi.fn() }));
vi.mock("./sync/orchestrator", () => ({ SyncOrchestrator: class {} }));
vi.mock("./sync/scheduler", () => ({ SyncScheduler: class {} }));
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
