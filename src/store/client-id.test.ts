import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { resolveClientId } from "./client-id";
import type { InstanceStore } from "./instance-store";

// Simulate Electron's window.require("os") returning a controllable hostname
const hostnameImpl = vi.fn<() => string>(() => "test-host");

function makeStore(clientId = ""): {
	store: InstanceStore;
	loadDevice: ReturnType<typeof vi.fn>;
	saveDevice: ReturnType<typeof vi.fn>;
} {
	const loadDevice = vi.fn().mockResolvedValue({ clientId });
	const saveDevice = vi.fn().mockResolvedValue(undefined);
	const store = { loadDevice, saveDevice } as unknown as InstanceStore;
	return { store, loadDevice, saveDevice };
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

	describe("desktop (hostname available)", () => {
		it("returns sanitized hostname via window.require", async () => {
			hostnameImpl.mockReturnValue("my-computer");
			const { store, loadDevice } = makeStore();
			const result = await resolveClientId(store);
			expect(result).toBe("my-computer");
			expect(loadDevice).not.toHaveBeenCalled();
		});

		it("sanitizes special characters in hostname", async () => {
			hostnameImpl.mockReturnValue("My Computer!");
			const { store } = makeStore();
			const result = await resolveClientId(store);
			expect(result).toBe("My_Computer_");
		});

		it("prefers HOSTNAME env var over window.require", async () => {
			process.env.HOSTNAME = "env-host";
			hostnameImpl.mockReturnValue("other-host");
			const { store } = makeStore();
			const result = await resolveClientId(store);
			expect(result).toBe("env-host");
			expect(hostnameImpl).not.toHaveBeenCalled();
		});
	});

	describe("mobile / no hostname", () => {
		it("returns stored client ID when hostname is empty", async () => {
			hostnameImpl.mockReturnValue("");
			const { store, saveDevice } = makeStore("Client_existing-uuid");
			const result = await resolveClientId(store);
			expect(result).toBe("Client_existing-uuid");
			expect(saveDevice).not.toHaveBeenCalled();
		});

		it("generates and persists a UUID when no stored ID exists", async () => {
			hostnameImpl.mockReturnValue("");
			vi.spyOn(crypto, "randomUUID").mockReturnValue(
				"generated-uuid" as `${string}-${string}-${string}-${string}-${string}`
			);
			const { store, saveDevice } = makeStore("");
			const result = await resolveClientId(store);
			expect(result).toBe("Client_generated-uuid");
			expect(saveDevice).toHaveBeenCalledWith({ clientId: "Client_generated-uuid" });
		});

		it("falls back to UUID path when window.require is unavailable", async () => {
			delete (globalThis as unknown as GlobalWithRequire).require;
			const { store } = makeStore("Client_fallback");
			const result = await resolveClientId(store);
			expect(result).toBe("Client_fallback");
		});

		it("falls back to UUID path when os.hostname throws", async () => {
			hostnameImpl.mockImplementation(() => { throw new Error("unavailable"); });
			const { store } = makeStore("Client_fallback");
			const result = await resolveClientId(store);
			expect(result).toBe("Client_fallback");
		});
	});
});
