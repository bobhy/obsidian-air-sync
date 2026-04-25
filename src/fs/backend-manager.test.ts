import { describe, it, expect, vi, beforeEach } from "vitest";
import { BackendManager, BackendManagerDeps } from "./backend-manager";
import type { IBackendProvider } from "./backend";
import type { AirSyncSettings } from "../settings";
import type { IFileSystem } from "./interface";
import type { Logger } from "../logging/logger";
import { AuthError } from "./errors";

// Mock the registry to return our fake provider
vi.mock("./registry", () => ({
	getBackendProvider: (type: string) => {
		if (type === "test") return fakeProvider;
		return undefined;
	},
}));

let fakeProvider: IBackendProvider;
let fakeFs: IFileSystem;

function mockSettings(overrides: Partial<AirSyncSettings> = {}): AirSyncSettings {
	return {
		backendType: "test",
		ignorePatterns: [],
		syncDotPaths: [],
		conflictStrategy: "auto_merge",
		enableThreeWayMerge: false,
		mobileMaxFileSizeMB: 10,
		enableLogging: false,
		logLevel: "info",
		backendData: {},
		destructiveSyncThreshold: 10,
		...overrides,
	};
}

function createDeps(settings: AirSyncSettings, overrides: Partial<BackendManagerDeps> = {}): BackendManagerDeps {
	const noopLogger = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		flush: vi.fn(),
	} as unknown as Logger;

	return {
		getSettings: () => settings,
		saveSettings: vi.fn().mockResolvedValue(undefined),
		getApp: (() => ({ vault: { configDir: ".obsidian", adapter: { writeBinary: vi.fn().mockResolvedValue(undefined) } } })) as unknown as BackendManagerDeps["getApp"], // eslint-disable-line obsidianmd/hardcoded-config-path -- test only; real code uses app.vault.configDir
		getLogger: () => noopLogger,
		getVaultName: () => "Test Vault",
		onConnected: vi.fn(),
		onDisconnected: vi.fn(),
		onSyncTargetChanged: vi.fn().mockResolvedValue(undefined),
		notify: vi.fn(),
		refreshSettingsDisplay: vi.fn(),
		hasSyncHistory: vi.fn().mockResolvedValue(false),
		localHasContentFiles: vi.fn().mockReturnValue(false),
		reloadSettings: vi.fn().mockResolvedValue(undefined),
		promptJoinConflict: vi.fn().mockResolvedValue("cancel" as const),
		...overrides,
	};
}

beforeEach(() => {
	fakeFs = {
		name: "test-remote",
		list: vi.fn().mockResolvedValue([]),
		stat: vi.fn().mockResolvedValue(null),
		read: vi.fn(),
		write: vi.fn(),
		mkdir: vi.fn(),
		delete: vi.fn(),
		rename: vi.fn(),
	} as unknown as IFileSystem;

	fakeProvider = {
		type: "test",
		displayName: "Test",
		auth: {
			isAuthenticated: () => true,
			startAuth: vi.fn(),
			completeAuth: vi.fn(),
		},
		createFs: () => fakeFs,
		isConnected: () => true,
		getSyncTarget: () => "test:folder-A",
		resetTargetState: vi.fn(),
		disconnect: vi.fn().mockResolvedValue({}),
	};
});

describe("BackendManager — sync target change triggers onSyncTargetChanged", () => {
	it("does not call onSyncTargetChanged on first initBackend call", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		expect(deps.onSyncTargetChanged).not.toHaveBeenCalled();
		expect(deps.onConnected).toHaveBeenCalled();
	});

	it("calls onSyncTargetChanged when sync target changes between initBackend calls", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend(); // identity = "test:folder-A"

		// Change identity
		fakeProvider.getSyncTarget = () => "test:folder-B";
		await mgr.initBackend();

		expect(deps.onSyncTargetChanged).toHaveBeenCalledTimes(1);
	});

	it("does not call onSyncTargetChanged when sync target stays the same", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();
		await mgr.initBackend();

		expect(deps.onSyncTargetChanged).not.toHaveBeenCalled();
	});

	it("does NOT call onSyncTargetChanged on disconnect (sync state preserved for reconnect)", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();
		await mgr.disconnectBackend();

		expect(deps.onSyncTargetChanged).not.toHaveBeenCalled();

		// Re-init with same identity after disconnect should also not trigger callback
		await mgr.initBackend();
		expect(deps.onSyncTargetChanged).not.toHaveBeenCalled();
	});

	it("calls onSyncTargetChanged via completeBackendConnect when vault folder switches after disconnect", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		// initBackend establishes backendProvider and identity "test:folder-A"
		await mgr.initBackend();
		(deps.onSyncTargetChanged as ReturnType<typeof vi.fn>).mockClear();

		await mgr.disconnectBackend();
		expect(deps.onSyncTargetChanged).not.toHaveBeenCalled();

		// Reconnect with a different vault folder — identity switches to "test:folder-B"
		fakeProvider.getSyncTarget = () => "test:folder-B";
		await mgr.completeBackendConnect("auth-code");

		expect(deps.onSyncTargetChanged).toHaveBeenCalledTimes(1);
	});

	it("calls provider.resetTargetState on identity change", async () => {
		const resetSpy = vi.fn();
		fakeProvider.resetTargetState = resetSpy;

		const settings = mockSettings({
			backendData: {
				test: { changesStartPageToken: "old-token", other: "keep" },
			},
		});
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend(); // identity = "test:folder-A"

		fakeProvider.getSyncTarget = () => "test:folder-B";
		await mgr.initBackend();

		expect(resetSpy).toHaveBeenCalledTimes(1);
		expect(resetSpy).toHaveBeenCalledWith(settings);
	});
});

describe("BackendManager — auth error notification on initBackend", () => {
	it("notifies user when initBackend fails with AuthError", async () => {
		fakeProvider.resolveRemoteVault = () => {
			throw new AuthError("Token refresh failed", 400);
		};

		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		expect(deps.notify).toHaveBeenCalledWith(
			"Authentication expired. Please reconnect in settings."
		);
	});

	it("does not notify for non-auth errors", async () => {
		fakeProvider.resolveRemoteVault = () => {
			const err = new Error("Network error");
			(err as Error & { status: number }).status = 503;
			throw err;
		};

		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		expect(deps.notify).not.toHaveBeenCalled();
	});
});

describe("BackendManager — isConnected false with prior connection", () => {
	it("notifies when isConnected is false but remoteVaultFolder exists", async () => {
		fakeProvider.isConnected = () => false;

		const settings = mockSettings({
			backendData: { test: { remoteVaultFolder: "my-vault" } },
		});
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		expect(deps.notify).toHaveBeenCalledWith(
			"Authentication expired. Please reconnect in settings."
		);
		expect(deps.onDisconnected).toHaveBeenCalled();
	});

	it("does not notify when isConnected is false and no prior connection", async () => {
		fakeProvider.isConnected = () => false;

		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		expect(deps.notify).not.toHaveBeenCalled();
		expect(deps.onDisconnected).toHaveBeenCalled();
	});
});

describe("BackendManager — isConnecting flag", () => {
	it("returns false before initBackend is called", () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		expect(mgr.isConnecting()).toBe(false);
	});

	it("returns true while initBackend is in progress", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		let connectingDuringInit = false;
		let resolve!: () => void;
		const blocker = new Promise<void>((r) => { resolve = r; });

		fakeProvider.resolveRemoteVault = async () => {
			connectingDuringInit = mgr.isConnecting();
			await blocker;
			return { backendUpdates: { remoteVaultFolder: "" }, wasCreated: false };
		};

		const initPromise = mgr.initBackend();

		// Wait a tick for the async code to reach the blocker
		await Promise.resolve();

		expect(connectingDuringInit).toBe(true);
		resolve();
		await initPromise;
	});

	it("returns false after initBackend completes successfully", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		expect(mgr.isConnecting()).toBe(false);
	});

	it("returns false after initBackend fails", async () => {
		fakeProvider.resolveRemoteVault = () => {
			throw new Error("network error");
		};

		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		expect(mgr.isConnecting()).toBe(false);
	});

	it("second concurrent call to initBackend is ignored (early return)", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		let resolve!: () => void;
		const blocker = new Promise<void>((r) => { resolve = r; });

		fakeProvider.resolveRemoteVault = async () => {
			await blocker;
			return { backendUpdates: { remoteVaultFolder: "" }, wasCreated: false };
		};

		const first = mgr.initBackend();
		const second = mgr.initBackend(); // should be ignored

		resolve();
		await Promise.all([first, second]);

		// onConnected should only be called once
		expect(deps.onConnected).toHaveBeenCalledTimes(1);
	});

	it("returns true while completeBackendConnect is in progress", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		// Ensure backendProvider is set
		await mgr.initBackend();

		let connectingDuringComplete = false;
		let resolve!: () => void;
		const blocker = new Promise<void>((r) => { resolve = r; });

		fakeProvider.auth.completeAuth = async () => {
			connectingDuringComplete = mgr.isConnecting();
			await blocker;
			return {};
		};

		const completePromise = mgr.completeBackendConnect("auth-code");

		await Promise.resolve();

		expect(connectingDuringComplete).toBe(true);
		resolve();
		await completePromise;
	});

	it("returns false after completeBackendConnect completes", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		fakeProvider.auth.completeAuth = () => Promise.resolve({});

		await mgr.completeBackendConnect("auth-code");

		expect(mgr.isConnecting()).toBe(false);
	});

	it("returns false after completeBackendConnect fails", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		fakeProvider.auth.completeAuth = () => { throw new Error("auth failed"); };

		await mgr.completeBackendConnect("auth-code");

		expect(mgr.isConnecting()).toBe(false);
	});

	it("completeBackendConnect shows 'creating' toast when wasCreated=true", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		fakeProvider.auth.completeAuth = () => Promise.resolve({});
		fakeProvider.resolveRemoteVault = () => Promise.resolve({ backendUpdates: { remoteVaultFolder: "" }, wasCreated: true });

		await mgr.completeBackendConnect("auth-code");

		expect(deps.notify).toHaveBeenCalledWith(
			expect.stringContaining("creating one")
		);
	});

	it("completeBackendConnect shows 'resuming' toast when wasCreated=false and hasSyncHistory=true", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings, {
			hasSyncHistory: vi.fn().mockResolvedValue(true),
		});
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		fakeProvider.auth.completeAuth = () => Promise.resolve({});
		fakeProvider.resolveRemoteVault = () => Promise.resolve({ backendUpdates: { remoteVaultFolder: "" }, wasCreated: false });

		await mgr.completeBackendConnect("auth-code");

		expect(deps.notify).toHaveBeenCalledWith(
			expect.stringContaining("Resuming sync")
		);
	});

	it("completeBackendConnect shows 'downloading' toast and seeds settings when fresh device joins", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings, {
			hasSyncHistory: vi.fn().mockResolvedValue(false),
			localHasContentFiles: vi.fn().mockReturnValue(false),
		});
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		fakeProvider.auth.completeAuth = () => Promise.resolve({});
		fakeProvider.resolveRemoteVault = () => Promise.resolve({ backendUpdates: { remoteVaultFolder: "" }, wasCreated: false });

		await mgr.completeBackendConnect("auth-code");

		expect(deps.notify).toHaveBeenCalledWith(
			expect.stringContaining("Downloading")
		);
		expect(deps.reloadSettings).toHaveBeenCalled();
	});

	it("completeBackendConnect prompts user when local has content and no sync history", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings, {
			hasSyncHistory: vi.fn().mockResolvedValue(false),
			localHasContentFiles: vi.fn().mockReturnValue(true),
			promptJoinConflict: vi.fn().mockResolvedValue("cancel" as const),
		});
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		fakeProvider.auth.completeAuth = () => Promise.resolve({});
		fakeProvider.resolveRemoteVault = () => Promise.resolve({ backendUpdates: { remoteVaultFolder: "" }, wasCreated: false });

		await mgr.completeBackendConnect("auth-code");

		expect(deps.promptJoinConflict).toHaveBeenCalledWith("Test Vault");
	});

	it("completeBackendConnect disconnects when user cancels conflict", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings, {
			hasSyncHistory: vi.fn().mockResolvedValue(false),
			localHasContentFiles: vi.fn().mockReturnValue(true),
			promptJoinConflict: vi.fn().mockResolvedValue("cancel" as const),
		});
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		fakeProvider.auth.completeAuth = () => Promise.resolve({});
		fakeProvider.resolveRemoteVault = () => Promise.resolve({ backendUpdates: { remoteVaultFolder: "" }, wasCreated: false });
		fakeProvider.disconnect = vi.fn().mockResolvedValue({});

		await mgr.completeBackendConnect("auth-code");

		expect(deps.onDisconnected).toHaveBeenCalled();
	});

	it("completeBackendConnect seeds settings and proceeds when user chooses combine", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings, {
			hasSyncHistory: vi.fn().mockResolvedValue(false),
			localHasContentFiles: vi.fn().mockReturnValue(true),
			promptJoinConflict: vi.fn().mockResolvedValue("combine" as const),
		});
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		fakeProvider.auth.completeAuth = () => Promise.resolve({});
		fakeProvider.resolveRemoteVault = () => Promise.resolve({ backendUpdates: { remoteVaultFolder: "" }, wasCreated: false });

		await mgr.completeBackendConnect("auth-code");

		expect(deps.reloadSettings).toHaveBeenCalled();
		// Should NOT disconnect
		expect(deps.onDisconnected).not.toHaveBeenCalled();
	});

	it("completeBackendConnect is ignored when initBackend is in progress", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		let resolve!: () => void;
		const blocker = new Promise<void>((r) => { resolve = r; });

		fakeProvider.resolveRemoteVault = async () => {
			await blocker;
			return { backendUpdates: { remoteVaultFolder: "" }, wasCreated: false };
		};

		const initPromise = mgr.initBackend();

		// completeBackendConnect should be ignored since connecting is true
		const completeSpy = vi.spyOn(fakeProvider.auth, "completeAuth");
		await mgr.completeBackendConnect("auth-code");

		expect(completeSpy).not.toHaveBeenCalled();

		resolve();
		await initPromise;
	});

	it("initBackend is ignored when completeBackendConnect is in progress", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();
		(deps.onConnected as ReturnType<typeof vi.fn>).mockClear();

		let resolve!: () => void;
		const blocker = new Promise<void>((r) => { resolve = r; });

		fakeProvider.auth.completeAuth = async () => {
			await blocker;
			return {};
		};

		const completePromise = mgr.completeBackendConnect("auth-code");

		// initBackend should be ignored since connecting is true
		await mgr.initBackend();
		expect(deps.onConnected).not.toHaveBeenCalled();

		resolve();
		await completePromise;
	});
});
