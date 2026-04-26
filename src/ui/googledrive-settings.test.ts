import { describe, it, expect, vi, afterEach } from "vitest";
import { Setting } from "obsidian";
import { GoogleDriveSettingsRenderer } from "./googledrive-settings";
import type { AirSyncSettings } from "../settings";
import { DEFAULT_SETTINGS } from "../settings";
import type { BackendConnectionActions } from "./backend-settings";
import type { App } from "obsidian";

vi.mock("obsidian");
vi.mock("../fs/registry", () => ({
	getBackendProvider: vi.fn().mockReturnValue({ isConnected: () => false }),
}));

afterEach(() => vi.restoreAllMocks());

function makeSettings(googledrive: Record<string, unknown> = {}): AirSyncSettings {
	return { ...DEFAULT_SETTINGS, backendData: { googledrive } };
}

function makeActions(): BackendConnectionActions {
	return {
		startAuth: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
		completeAuth: vi.fn<(code: string) => Promise<void>>().mockResolvedValue(undefined),
		disconnect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
		refreshDisplay: vi.fn(),
		clearSyncHistory: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
	};
}

function makeApp(vaultName = "test-vault"): App {
	return { vault: { getName: () => vaultName } } as unknown as App;
}

/**
 * Render the Google Drive settings and return helpers for exercising the
 * "Remote vault folder" text field's onChange handler.
 */
function renderAndCapture(
	settings: AirSyncSettings,
	onSave: (updates: Record<string, unknown>) => Promise<void>,
	actions: BackendConnectionActions,
	app: App,
): {
	triggerChange: (value: string) => Promise<void>;
	setValueCalls: () => string[];
} {
	let capturedOnChange: ((v: string) => Promise<void>) | undefined;
	const setValueHistory: string[] = [];

	vi.spyOn(Setting.prototype, "addText").mockImplementation(function (
		this: Setting,
		cb: unknown,
	) {
		const mockText = {
			setPlaceholder: vi.fn().mockReturnThis(),
			setValue: vi.fn().mockImplementation(function (v: string) {
				setValueHistory.push(v);
				return mockText;
			}),
			setDisabled: vi.fn().mockReturnThis(),
			onChange: vi.fn().mockImplementation(function (handler: (v: string) => Promise<void>) {
				capturedOnChange = handler;
				return mockText;
			}),
		};
		(cb as (t: typeof mockText) => void)(mockText);
		return this;
	});

	new GoogleDriveSettingsRenderer().render(
		{} as HTMLElement,
		settings,
		onSave,
		actions,
		app,
	);

	return {
		triggerChange: (value: string) => {
			if (!capturedOnChange) throw new Error("onChange was not registered");
			return capturedOnChange(value);
		},
		setValueCalls: () => setValueHistory,
	};
}

describe("GoogleDriveSettingsRenderer — remote vault folder", () => {
	it("sanitizes unclean input: saves the cleaned value and echoes it back to the field", async () => {
		const onSave = vi.fn<(updates: Record<string, unknown>) => Promise<void>>().mockResolvedValue(undefined);
		const actions = makeActions();
		const { triggerChange, setValueCalls } = renderAndCapture(
			makeSettings(),
			onSave,
			actions,
			makeApp(),
		);

		await triggerChange("My Vault!");

		// Stored value must be sanitized ("My_Vault_"), not the raw input
		expect(onSave).toHaveBeenCalledWith({ remoteVaultFolderName: "My_Vault_" });
		// Field must be updated to show the sanitized form
		expect(setValueCalls()).toContain("My_Vault_");
	});

	it("does not call setValue when input is already clean", async () => {
		const onSave = vi.fn<(updates: Record<string, unknown>) => Promise<void>>().mockResolvedValue(undefined);
		const actions = makeActions();
		const { triggerChange, setValueCalls } = renderAndCapture(
			makeSettings(),
			onSave,
			actions,
			makeApp("my-vault"),
		);

		await triggerChange("my-clean-name");

		expect(onSave).toHaveBeenCalledWith({ remoteVaultFolderName: "my-clean-name" });
		// setValue is only called during initial setup (with "") — not again for clean input
		expect(setValueCalls()).not.toContain("my-clean-name");
	});
});
