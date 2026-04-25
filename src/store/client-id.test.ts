import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { resolveClientId } from "./client-id";
import type { InstanceStore } from "./instance-store";

const hostnameImpl = vi.fn<() => string>(() => "test-host");

function makeStore(opts: { clientId?: string; vaultId?: string } = {}): {
	store: InstanceStore;
	loadDevice: ReturnType<typeof vi.fn>;
	saveDevice: ReturnType<typeof vi.fn>;
	loadVaultRecord: ReturnType<typeof vi.fn>;
	saveVaultRecord: ReturnType<typeof vi.fn>;
} {
	const { clientId = "", vaultId = "" } = opts;
	const loadDevice = vi.fn().mockResolvedValue({ clientId });
	const saveDevice = vi.fn().mockResolvedValue(undefined);
	const loadVaultRecord = vi.fn().mockResolvedValue({ vaultId });
	const saveVaultRecord = vi.fn().mockResolvedValue(undefined);
	const store = { loadDevice, saveDevice, loadVaultRecord, saveVaultRecord } as unknown as InstanceStore;
	return { store, loadDevice, saveDevice, loadVaultRecord, saveVaultRecord };
}

type GlobalWithRequire = { require?: (id: string) => unknown };

describe("resolveClientId", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.HOSTNAME;
		(globalThis as unknown as GlobalWithRequire).require = (id: string) => {
			if (id === "os") return { hostname: hostnameImpl };
			throw new Error(`Unexpected require: ${id}`);
		};
	});

	afterEach(() => {
		delete process.env.HOSTNAME;
		delete (globalThis as unknown as GlobalWithRequire).require;
	});

	describe("desktop (hostname + vaultPath available)", () => {
		it("returns sanitized hostname plus 8-char path hash", async () => {
			hostnameImpl.mockReturnValue("my-computer");
			const { store } = makeStore();
			const result = await resolveClientId(store, "vault", "/home/user/vault");
			expect(result).toMatch(/^my-computer_[0-9a-f]{8}$/);
		});

		it("same path always yields the same suffix", async () => {
			hostnameImpl.mockReturnValue("host");
			const { store } = makeStore();
			const r1 = await resolveClientId(store, "vault", "/path/to/vault");
			const r2 = await resolveClientId(store, "vault", "/path/to/vault");
			expect(r1).toBe(r2);
		});

		it("different vault paths produce different suffixes", async () => {
			hostnameImpl.mockReturnValue("host");
			const { store } = makeStore();
			const r1 = await resolveClientId(store, "vault", "/path/one");
			const r2 = await resolveClientId(store, "vault", "/path/two");
			expect(r1).not.toBe(r2);
		});

		it("sanitizes special characters in hostname", async () => {
			hostnameImpl.mockReturnValue("My Computer!");
			const { store } = makeStore();
			const result = await resolveClientId(store, "vault", "/path");
			expect(result).toMatch(/^My_Computer__[0-9a-f]{8}$/);
		});

		it("prefers HOSTNAME env var over window.require", async () => {
			process.env.HOSTNAME = "env-host";
			hostnameImpl.mockReturnValue("other-host");
			const { store } = makeStore();
			const result = await resolveClientId(store, "vault", "/path");
			expect(result).toMatch(/^env-host_[0-9a-f]{8}$/);
			expect(hostnameImpl).not.toHaveBeenCalled();
		});

		it("does not access IDB when hostname and vaultPath are both available", async () => {
			hostnameImpl.mockReturnValue("host");
			const { store, loadDevice, loadVaultRecord } = makeStore();
			await resolveClientId(store, "vault", "/path");
			expect(loadDevice).not.toHaveBeenCalled();
			expect(loadVaultRecord).not.toHaveBeenCalled();
		});
	});

	describe("mobile / no hostname / no vaultPath", () => {
		it("returns stored device + vault IDs", async () => {
			hostnameImpl.mockReturnValue("");
			const { store, saveDevice, saveVaultRecord } = makeStore({
				clientId: "Client_device-uuid",
				vaultId: "vault-uuid",
			});
			const result = await resolveClientId(store, "my-vault", "");
			expect(result).toBe("Client_device-uuid_vault-uuid");
			expect(saveDevice).not.toHaveBeenCalled();
			expect(saveVaultRecord).not.toHaveBeenCalled();
		});

		it("generates and persists a vault UUID when none is stored", async () => {
			hostnameImpl.mockReturnValue("");
			vi.spyOn(crypto, "randomUUID").mockReturnValue(
				"generated-vault-uuid" as `${string}-${string}-${string}-${string}-${string}`
			);
			const { store, saveVaultRecord } = makeStore({ clientId: "Client_device-uuid" });
			const result = await resolveClientId(store, "my-vault", "");
			expect(result).toBe("Client_device-uuid_generated-vault-uuid");
			expect(saveVaultRecord).toHaveBeenCalledWith("my-vault", { vaultId: "generated-vault-uuid" });
		});

		it("generates and persists a device UUID when none is stored", async () => {
			hostnameImpl.mockReturnValue("");
			vi.spyOn(crypto, "randomUUID")
				.mockReturnValueOnce("new-device-uuid" as `${string}-${string}-${string}-${string}-${string}`)
				.mockReturnValueOnce("new-vault-uuid" as `${string}-${string}-${string}-${string}-${string}`);
			const { store, saveDevice } = makeStore();
			const result = await resolveClientId(store, "my-vault", "");
			expect(result).toBe("Client_new-device-uuid_new-vault-uuid");
			expect(saveDevice).toHaveBeenCalledWith({ clientId: "Client_new-device-uuid" });
		});

		it("falls back to UUID path when window.require is unavailable", async () => {
			delete (globalThis as unknown as GlobalWithRequire).require;
			const { store } = makeStore({ clientId: "Client_device", vaultId: "vault-id" });
			const result = await resolveClientId(store, "my-vault", "");
			expect(result).toBe("Client_device_vault-id");
		});

		it("falls back to UUID path when os.hostname throws", async () => {
			hostnameImpl.mockImplementation(() => { throw new Error("unavailable"); });
			const { store } = makeStore({ clientId: "Client_device", vaultId: "vault-id" });
			const result = await resolveClientId(store, "my-vault", "");
			expect(result).toBe("Client_device_vault-id");
		});
	});
});
