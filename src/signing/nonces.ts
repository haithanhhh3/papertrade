// Client-chosen intent nonces, persisted per (wallet, namespace) like the frontend:
// start at a random 24-bit value × 256, then increment. The next value is written to disk
// before the nonce is handed out, so a crash can never reuse one.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../util/fsStore.js";

export type NonceNamespace = "session" | "paper";

export function randomStartNonce(): bigint {
  const b = randomBytes(3);
  const n = (BigInt(b[0]!) << 16n) | (BigInt(b[1]!) << 8n) | BigInt(b[2]!);
  return (n === 0n ? 1n : n) * 256n;
}

export class NonceStore {
  private readonly path: string;
  private state: Record<string, string>;

  constructor(dataDir: string, chainId: number) {
    this.path = join(dataDir, `nonces-${chainId}.json`);
    this.state = readJson<Record<string, string>>(this.path, {});
  }

  private key(wallet: string, ns: NonceNamespace, verifyingContract: string): string {
    return `${wallet.toLowerCase()}:${ns}:${verifyingContract.toLowerCase()}`;
  }

  take(wallet: string, ns: NonceNamespace, verifyingContract: string): bigint {
    const k = this.key(wallet, ns, verifyingContract);
    const current = this.state[k] !== undefined ? BigInt(this.state[k]!) : randomStartNonce();
    this.state[k] = (current + 1n).toString();
    writeJsonAtomic(this.path, this.state);
    return current;
  }
}
