import { describe, it, expect } from "vitest";
import { computeSignature, readRemoteSignature, writeRemoteSignature } from "./signature";
import type { SyncPlan } from "./types";
import { createMockFs, addFile } from "../__mocks__/sync-test-helpers";

function makePlan(actions: SyncPlan["actions"]): SyncPlan {
	return { actions, safetyCheck: { shouldAbort: false, requiresConfirmation: false } };
}

describe("computeSignature", () => {
	it("returns '0' for an empty plan", () => {
		expect(computeSignature(makePlan([]))).toBe("0");
	});

	it("returns '0' when all actions are 'match'", () => {
		const plan = makePlan([
			{ action: "match", path: "a.md" },
			{ action: "match", path: "b.md" },
		]);
		expect(computeSignature(plan)).toBe("0");
	});

	it("returns a non-zero string for modifying actions", () => {
		const plan = makePlan([
			{ action: "push", path: "a.md" },
		]);
		const sig = computeSignature(plan);
		expect(sig).not.toBe("0");
		expect(typeof sig).toBe("string");
	});

	it("produces the same signature for the same set of actions regardless of order", () => {
		const plan1 = makePlan([
			{ action: "push", path: "a.md" },
			{ action: "pull", path: "b.md" },
		]);
		const plan2 = makePlan([
			{ action: "pull", path: "b.md" },
			{ action: "push", path: "a.md" },
		]);
		expect(computeSignature(plan1)).toBe(computeSignature(plan2));
	});

	it("produces different signatures for different action sets", () => {
		const plan1 = makePlan([{ action: "push", path: "a.md" }]);
		const plan2 = makePlan([{ action: "pull", path: "a.md" }]);
		expect(computeSignature(plan1)).not.toBe(computeSignature(plan2));
	});

	it("produces different signatures for different paths", () => {
		const plan1 = makePlan([{ action: "push", path: "a.md" }]);
		const plan2 = makePlan([{ action: "push", path: "b.md" }]);
		expect(computeSignature(plan1)).not.toBe(computeSignature(plan2));
	});

	it("ignores match actions when computing the signature", () => {
		const plan1 = makePlan([{ action: "push", path: "a.md" }]);
		const plan2 = makePlan([
			{ action: "push", path: "a.md" },
			{ action: "match", path: "b.md" },
		]);
		expect(computeSignature(plan1)).toBe(computeSignature(plan2));
	});
});

describe("readRemoteSignature", () => {
	it("returns '0' when file does not exist", async () => {
		const fs = createMockFs("remote");
		const sig = await readRemoteSignature(fs, "my-client");
		expect(sig).toBe("0");
	});

	it("returns the stored signature when file exists", async () => {
		const fs = createMockFs("remote");
		const content = JSON.stringify({ lastSyncSignature: "12345" });
		addFile(fs, ".airsync/my-client.json", content);

		const sig = await readRemoteSignature(fs, "my-client");
		expect(sig).toBe("12345");
	});

	it("returns '0' when file exists but has no lastSyncSignature field", async () => {
		const fs = createMockFs("remote");
		addFile(fs, ".airsync/my-client.json", JSON.stringify({ other: "value" }));

		const sig = await readRemoteSignature(fs, "my-client");
		expect(sig).toBe("0");
	});

	it("returns '0' when file content is invalid JSON", async () => {
		const fs = createMockFs("remote");
		addFile(fs, ".airsync/my-client.json", "not-json{{{");

		const sig = await readRemoteSignature(fs, "my-client");
		expect(sig).toBe("0");
	});
});

describe("writeRemoteSignature", () => {
	it("writes the signature to the correct path", async () => {
		const fs = createMockFs("remote");
		await writeRemoteSignature(fs, "my-client", "99999");

		const entry = fs.files.get(".airsync/my-client.json");
		expect(entry).toBeDefined();
		const text = new TextDecoder().decode(entry!.content);
		expect(JSON.parse(text)).toEqual({ lastSyncSignature: "99999" });
	});

	it("can be read back by readRemoteSignature", async () => {
		const fs = createMockFs("remote");
		await writeRemoteSignature(fs, "test-device", "abc123");

		const sig = await readRemoteSignature(fs, "test-device");
		expect(sig).toBe("abc123");
	});
});
