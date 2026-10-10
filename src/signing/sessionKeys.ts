// Session keys: a locally generated secp256k1 key that the main wallet authorises once
// (RegisterSessionKey) and that then signs opens, closes and cancels. It cannot withdraw or stake.

import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { readJson, writeJsonAtomic } from "../util/fsStore.js";

export interface StoredSessionKey {
  wallet: Address;
  privateKey: Hex;
  address: Address;
  expirySec: number;
  createdAtMs: number;
  /** Intent id of the RegisterSessionKey submission, once sent. */
  registrationIntentId?: Hex;
  /** Set once the key is listed as registered in the wallet stream. */
  confirmed?: boolean;
}

export class SessionKeyStore {
  private readonly path: string;
  private keys: StoredSessionKey[];

  constructor(dataDir: string) {
    this.path = join(dataDir, "session-keys.json");
    this.keys = readJson<StoredSessionKey[]>(this.path, []);
  }

  private save(): void {
    writeJsonAtomic(this.path, this.keys, 0o600);
  }

  private valid(wallet: Address, nowSec: number): StoredSessionKey[] {
    return this.keys
      .filter((k) => k.wallet.toLowerCase() === wallet.toLowerCase() && k.expirySec > nowSec)
      .sort((a, b) => b.expirySec - a.expirySec);
  }

  /**
   * Key to sign with: the newest key confirmed as registered; before any confirmation (first
   * registration), the newest stored key. A renewal in flight never displaces a working key.
   */
  latest(wallet: Address, nowSec = Date.now() / 1000): StoredSessionKey | undefined {
    const valid = this.valid(wallet, nowSec);
    return valid.find((k) => k.confirmed) ?? valid[0];
  }

  /** True when a key was created for this wallet in the last `windowMs` and is not confirmed yet. */
  registrationPending(wallet: Address, nowMs = Date.now(), windowMs = 600_000): boolean {
    return this.valid(wallet, nowMs / 1000).some((k) => !k.confirmed && nowMs - k.createdAtMs < windowMs);
  }

  /** Mark stored keys that the wallet stream lists as registered. */
  markConfirmed(wallet: Address, registered: ReadonlyMap<string, number>): void {
    let changed = false;
    for (const k of this.keys) {
      if (k.wallet.toLowerCase() === wallet.toLowerCase() && !k.confirmed && registered.has(k.address.toLowerCase())) {
        k.confirmed = true;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  create(wallet: Address, ttlSec: number, nowMs = Date.now()): StoredSessionKey {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const key: StoredSessionKey = {
      wallet: wallet.toLowerCase() as Address,
      privateKey,
      address: account.address.toLowerCase() as Address,
      expirySec: Math.floor(nowMs / 1000) + Math.floor(ttlSec),
      createdAtMs: nowMs,
    };
    this.keys.push(key);
    this.prune();
    this.save();
    return key;
  }

  markSubmitted(key: StoredSessionKey, intentId: Hex): void {
    key.registrationIntentId = intentId;
    this.save();
  }

  account(key: StoredSessionKey): PrivateKeyAccount {
    return privateKeyToAccount(key.privateKey);
  }

  private prune(nowSec = Date.now() / 1000): void {
    this.keys = this.keys.filter((k) => k.expirySec > nowSec);
  }
}
