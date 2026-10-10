import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionKeyStore } from "../src/signing/sessionKeys.js";

const WALLET = "0x00000000000000000000000000000000000000aa";

describe("SessionKeyStore", () => {
  it("keeps signing with the confirmed key while a renewal is pending", () => {
    const store = new SessionKeyStore(mkdtempSync(join(tmpdir(), "ptbot-sk-")));
    const now = Date.now();
    const first = store.create(WALLET, 86_400, now - 3_600_000);
    expect(store.latest(WALLET)!.address).toBe(first.address); // unconfirmed but the only one
    store.markConfirmed(WALLET, new Map([[first.address, first.expirySec]]));

    const renewal = store.create(WALLET, 30 * 86_400, now);
    expect(store.latest(WALLET)!.address).toBe(first.address);
    expect(store.registrationPending(WALLET, now)).toBe(true);

    store.markConfirmed(WALLET, new Map([[renewal.address, renewal.expirySec]]));
    expect(store.latest(WALLET)!.address).toBe(renewal.address);
    expect(store.registrationPending(WALLET, now)).toBe(false);
  });

  it("persists keys with restrictive permissions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ptbot-sk-"));
    const store = new SessionKeyStore(dir);
    const k = store.create(WALLET, 86_400);
    const again = new SessionKeyStore(dir);
    expect(again.latest(WALLET)!.privateKey).toBe(k.privateKey);
    const { statSync } = await import("node:fs");
    expect(statSync(join(dir, "session-keys.json")).mode & 0o777).toBe(0o600);
  });
});
