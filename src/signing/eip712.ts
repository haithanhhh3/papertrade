// EIP-712 typed data for Papertrade intents, matching the official frontend byte for byte
// (same library: viem). Domains were verified against on-chain DOMAIN_SEPARATOR values.

import {
  concat,
  hashTypedData,
  keccak256,
  recoverAddress,
  parseSignature,
  toBytes,
  type Address,
  type Hex,
  type LocalAccount,
  type TypedDataDomain,
} from "viem";

export const INTENT_TYPES = {
  RegisterSessionKey: [
    { name: "user", type: "address" },
    { name: "key", type: "address" },
    { name: "expiry", type: "uint64" },
    { name: "feeAddress", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  OpenPosition: [
    { name: "user", type: "address" },
    { name: "instrumentId", type: "uint32" },
    { name: "isLong", type: "bool" },
    { name: "size", type: "uint128" },
    { name: "leverage", type: "uint32" },
    { name: "useDebt", type: "bool" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  Close: [
    { name: "user", type: "address" },
    { name: "positionIds", type: "uint256[]" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  WithdrawToCore: [
    { name: "user", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  Stake: [
    { name: "user", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  Unstake: [
    { name: "user", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  Claim: [
    { name: "user", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  CancelIntent: [
    { name: "user", type: "address" },
    { name: "intentId", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export type IntentType = keyof typeof INTENT_TYPES;

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
export const INTENT_ID_TAG = keccak256(toBytes("papertrade:intent-id:v2"));
export const INTENT_LIFETIME_SEC = 3600;

export function exchangeDomain(chainId: number, exchange: Address): TypedDataDomain {
  return { name: "String", version: "1", chainId, verifyingContract: exchange };
}

export function stakingDomain(chainId: number, staking: Address): TypedDataDomain {
  return { name: "PaperStaking", version: "1", chainId, verifyingContract: staking };
}

export function cancellationDomain(chainId: number, exchange: Address): TypedDataDomain {
  return { name: "PaperTrade Intent Cancel", version: "2", chainId, verifyingContract: exchange };
}

export function intentDeadline(nowMs = Date.now()): bigint {
  return BigInt(Math.floor(nowMs / 1000) + INTENT_LIFETIME_SEC);
}

/** Field serialisation used in the `signed` body (same rules as the frontend). */
export function serializeField(type: string, value: unknown): unknown {
  if (type === "uint256[]") return (value as (bigint | number | string)[]).map((v) => BigInt(v).toString());
  if (type.startsWith("uint")) return BigInt(value as bigint | number | string).toString();
  if (type === "address" || type.startsWith("bytes")) return String(value).toLowerCase();
  return value;
}

export interface SignedIntent {
  /** Body for POST /intents (`signed`). */
  signed: Record<string, unknown>;
  digest: Hex;
  signer: Address;
  intentId: Hex;
}

export function computeIntentId(digest: Hex, signer: Address): Hex {
  return keccak256(concat([INTENT_ID_TAG, digest, signer.toLowerCase() as Hex]));
}

export async function signIntent<T extends IntentType>(
  account: LocalAccount,
  domain: TypedDataDomain,
  primaryType: T,
  message: Record<string, unknown>,
): Promise<SignedIntent> {
  const fields = INTENT_TYPES[primaryType];
  const types = { [primaryType]: fields } as Record<string, readonly { name: string; type: string }[]>;
  const typedMessage: Record<string, unknown> = {};
  const serialized: Record<string, unknown> = {};
  for (const { name, type } of fields) {
    if (!(name in message)) throw new Error(`${primaryType}: missing field ${name}`);
    const v = message[name];
    typedMessage[name] = Array.isArray(v) ? v.map((x) => BigInt(x as bigint)) : v;
    serialized[name] = serializeField(type, v);
  }
  const params = { domain, types, primaryType, message: typedMessage };
  const signature = await account.signTypedData(params as unknown as Parameters<LocalAccount["signTypedData"]>[0]);
  const digest = hashTypedData(params as unknown as Parameters<typeof hashTypedData>[0]);
  const signer = (await recoverAddress({ hash: digest, signature })).toLowerCase() as Address;
  if (signer !== account.address.toLowerCase()) throw new Error("signature does not recover to the signing account");
  const { r, s, yParity } = parseSignature(signature);
  if (yParity === undefined) throw new Error("signature missing yParity");
  return {
    signed: { ...serialized, v: String(27 + yParity), r: r.toLowerCase(), s: s.toLowerCase() },
    digest,
    signer,
    intentId: computeIntentId(digest, signer),
  };
}
