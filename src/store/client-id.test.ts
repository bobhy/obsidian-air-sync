import { describe, it, expect, vi, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { resolveClientId } from "./client-id";
import type { InstanceStore } from "./instance-store";

// Control os.hostname() behavior per test
const hostnameImpl = vi.hoisted(() => vi.fn<() => string>(() => "test-host"));
vi.mock("os", () => ({ hostname: hostnameImpl }));

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

describe("resolveClientId", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("desktop (hostname available)", () => {
		it("returns sanitized hostname", async () => {
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

		it("falls back to UUID path when os.hostname throws", async () => {
			hostnameImpl.mockImplementation(() => { throw new Error("unavailable"); });
			const { store } = makeStore("Client_fallback");
			const result = await resolveClientId(store);
			expect(result).toBe("Client_fallback");
		});
	});
});
