import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { concat, hashDomain, hashTypedData, keccak256, recoverAddress, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  computeIntentId,
  exchangeDomain,
  INTENT_TYPES,
  intentDeadline,
  serializeField,
  signIntent,
  stakingDomain,
} from "../src/signing/eip712.js";
import { NonceStore } from "../src/signing/nonces.js";

const EXCHANGE = "0x6cd5661646289FB6E65EA5C032310fDEd797D0a2";
const STAKING = "0xAAd6c7b0CC3014FC80FfEDAe0Ed7Ce5967b0F016";
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const domainSeparator = (d: ReturnType<typeof exchangeDomain>) =>
  hashDomain({
    domain: d as never,
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
    },
  });

describe("domains", () => {
  it("exchange domain equals the on-chain SessionKeyManager.DOMAIN_SEPARATOR()", () => {
    expect(domainSeparator(exchangeDomain(999, EXCHANGE))).toBe("0x53a2ab5a64b3239d36b108fb4cd035ebb40ed3f71dec28e37966622670147e77");
  });

  it("staking domain equals the on-chain PaperStaking.DOMAIN_SEPARATOR()", () => {
    expect(domainSeparator(stakingDomain(999, STAKING))).toBe("0x71706d56c8b436981e93987cd97df512528491b243c6d8d1614cad52659e7eb0");
  });
});

describe("signIntent", () => {
  const session = privateKeyToAccount(KEY);
  const user = "0x1111111111111111111111111111111111111111" as const;

  it("serialises fields like the frontend and produces a recoverable signature", async () => {
    const message = {
      user,
      instrumentId: 0,
      isLong: true,
      size: 112_500_000_000_000_000_000n,
      leverage: 150,
      useDebt: false,
      nonce: 1234n * 256n,
      deadline: 1_791_600_000n,
    };
    const s = await signIntent(session, exchangeDomain(999, EXCHANGE), "OpenPosition", message);
    expect(s.signed).toMatchObject({
      user,
      instrumentId: "0",
      isLong: true,
      size: "112500000000000000000",
      leverage: "150",
      useDebt: false,
      nonce: "315904",
      deadline: "1791600000",
    });
    expect(s.signed.v === "27" || s.signed.v === "28").toBe(true);
    expect(s.signed.r).toMatch(/^0x[0-9a-f]{64}$/);

    const digest = hashTypedData({
      domain: exchangeDomain(999, EXCHANGE),
      types: { OpenPosition: INTENT_TYPES.OpenPosition },
      primaryType: "OpenPosition",
      message,
    });
    expect(s.digest).toBe(digest);
    const signature = concat([s.signed.r as `0x${string}`, s.signed.s as `0x${string}`, s.signed.v === "27" ? "0x1b" : "0x1c"]);
    expect((await recoverAddress({ hash: digest, signature })).toLowerCase()).toBe(session.address.toLowerCase());
  });

  it("derives the intent id as keccak256(tag ‖ digest ‖ signer)", async () => {
    const s = await signIntent(session, exchangeDomain(999, EXCHANGE), "Close", { user, positionIds: [7n, 9n], nonce: 1n, deadline: 2n });
    const tag = keccak256(toBytes("papertrade:intent-id:v2"));
    expect(s.intentId).toBe(keccak256(concat([tag, s.digest, session.address.toLowerCase() as `0x${string}`])));
    expect(computeIntentId(s.digest, s.signer)).toBe(s.intentId);
    expect(s.signed.positionIds).toEqual(["7", "9"]);
  });

  it("rejects a message with a missing field", async () => {
    await expect(signIntent(session, exchangeDomain(999, EXCHANGE), "Claim", { user, nonce: 1n })).rejects.toThrow(/missing field deadline/);
  });

  it("lowercases addresses and bytes", () => {
    expect(serializeField("address", "0xABCDEF0000000000000000000000000000000000")).toBe("0xabcdef0000000000000000000000000000000000");
    expect(serializeField("uint64", 5)).toBe("5");
  });

  it("deadline is one hour ahead", () => {
    expect(intentDeadline(1_000_000)).toBe(BigInt(1000 + 3600));
  });
});

describe("nonces", () => {
  it("starts at a random multiple of 256, increments, and survives restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "ptbot-"));
    const a = new NonceStore(dir, 999);
    const n0 = a.take("0xAA", "session", EXCHANGE);
    expect(n0 % 256n).toBe(0n);
    expect(a.take("0xaa", "session", EXCHANGE)).toBe(n0 + 1n);
    const b = new NonceStore(dir, 999);
    expect(b.take("0xaa", "session", EXCHANGE)).toBe(n0 + 2n);
    expect(b.take("0xaa", "paper", STAKING) % 256n).toBe(0n);
  });
});
