// Signs and submits intents for one wallet. The intent id is computed locally before the POST,
// so a submission whose acknowledgement is lost can still be tracked through the wallet stream.

import type { Address, Hex, LocalAccount } from "viem";
import { IntentRejected, type IntentAction, type PapertradeApi } from "../api/client.js";
import type { IntentAccepted } from "../api/schemas.js";
import {
  cancellationDomain,
  exchangeDomain,
  intentDeadline,
  signIntent,
  stakingDomain,
  ZERO_ADDRESS,
  type IntentType,
  type SignedIntent,
} from "../signing/eip712.js";
import type { NonceStore } from "../signing/nonces.js";
import type { SessionKeyStore, StoredSessionKey } from "../signing/sessionKeys.js";
import { logger, type Logger } from "../util/log.js";

export interface SubmitResult {
  intentId: Hex;
  deadlineSec: bigint;
  /** Relayer acknowledgement; undefined when the outcome is unknown (timeout / network error). */
  accepted?: IntentAccepted;
}

export interface OpenParams {
  instrumentId: number;
  isLong: boolean;
  marginRaw: bigint;
  leverage: number;
  useDebt?: boolean;
}

export interface Contracts {
  exchange: Address;
  paperStaking: Address;
}

export class WalletExecutor {
  readonly address: Address;
  private readonly log: Logger;

  constructor(
    readonly label: string,
    private readonly main: LocalAccount,
    private readonly api: PapertradeApi,
    private readonly nonces: NonceStore,
    private readonly sessions: SessionKeyStore,
    private readonly chainId: number,
    private readonly contracts: Contracts,
  ) {
    this.address = main.address.toLowerCase() as Address;
    this.log = logger(`exec.${label}`);
  }

  sessionKey(): StoredSessionKey | undefined {
    return this.sessions.latest(this.address);
  }

  registrationPending(): boolean {
    return this.sessions.registrationPending(this.address);
  }

  /** Record which of our session keys the relayer lists as registered. */
  observeSessionKeys(registered: ReadonlyMap<string, number>): void {
    this.sessions.markConfirmed(this.address, registered);
  }

  private requireSession(): LocalAccount {
    const key = this.sessionKey();
    if (!key) throw new Error(`wallet ${this.label}: no valid session key; run \`register\` first`);
    return this.sessions.account(key);
  }

  private async send(action: IntentAction, intent: SignedIntent, deadlineSec: bigint): Promise<SubmitResult> {
    try {
      const accepted = await this.api.submit(action, intent.signed);
      if (accepted.intentId !== intent.intentId) {
        throw new Error(`relayer returned intent id ${accepted.intentId}, expected ${intent.intentId}`);
      }
      this.log.info("intent accepted", { action, intentId: intent.intentId, state: accepted.state });
      return { intentId: intent.intentId, deadlineSec, accepted };
    } catch (err) {
      if (err instanceof IntentRejected) {
        this.log.warn("intent rejected", { action, intentId: intent.intentId, code: err.code, reason: err.reason });
        throw err;
      }
      this.log.warn("intent outcome unknown", { action, intentId: intent.intentId, error: String(err) });
      return { intentId: intent.intentId, deadlineSec };
    }
  }

  private async signExchange(signer: LocalAccount, type: IntentType, message: Record<string, unknown>): Promise<SignedIntent> {
    return signIntent(signer, exchangeDomain(this.chainId, this.contracts.exchange), type, message);
  }

  private nonce(ns: "session" | "paper"): bigint {
    const vc = ns === "session" ? this.contracts.exchange : this.contracts.paperStaking;
    return this.nonces.take(this.address, ns, vc);
  }

  /** Main wallet authorises a new session key. */
  async registerSessionKey(ttlSec: number): Promise<{ key: StoredSessionKey; result: SubmitResult }> {
    const key = this.sessions.create(this.address, ttlSec);
    const deadline = intentDeadline();
    const intent = await this.signExchange(this.main, "RegisterSessionKey", {
      user: this.address,
      key: key.address,
      expiry: BigInt(key.expirySec),
      feeAddress: ZERO_ADDRESS,
      nonce: this.nonce("session"),
      deadline,
    });
    this.sessions.markSubmitted(key, intent.intentId);
    return { key, result: await this.send("registerSessionKey", intent, deadline) };
  }

  async open(p: OpenParams): Promise<SubmitResult> {
    const deadline = intentDeadline();
    const intent = await this.signExchange(this.requireSession(), "OpenPosition", {
      user: this.address,
      instrumentId: p.instrumentId,
      isLong: p.isLong,
      size: p.marginRaw,
      leverage: p.leverage,
      useDebt: p.useDebt ?? false,
      nonce: this.nonce("session"),
      deadline,
    });
    return this.send("openPosition", intent, deadline);
  }

  async close(positionIds: bigint[]): Promise<SubmitResult> {
    if (positionIds.length === 0 || positionIds.length > 12) throw new Error("close: 1..12 position ids per intent");
    const deadline = intentDeadline();
    const intent = await this.signExchange(this.requireSession(), "Close", {
      user: this.address,
      positionIds,
      nonce: this.nonce("session"),
      deadline,
    });
    return this.send("closePositions", intent, deadline);
  }

  async cancel(intentId: Hex): Promise<IntentAccepted> {
    const intent = await signIntent(this.requireSession(), cancellationDomain(this.chainId, this.contracts.exchange), "CancelIntent", {
      user: this.address,
      intentId,
      deadline: intentDeadline(),
    });
    const { intentId: _omit, ...body } = intent.signed;
    return this.api.cancel(intentId, body);
  }

  async stake(amount: bigint): Promise<SubmitResult> {
    return this.paperAction("paperStake", "Stake", { amount });
  }

  async claim(): Promise<SubmitResult> {
    return this.paperAction("paperClaim", "Claim", {});
  }

  private async paperAction(action: IntentAction, type: IntentType, extra: Record<string, unknown>): Promise<SubmitResult> {
    const deadline = intentDeadline();
    const intent = await signIntent(this.main, stakingDomain(this.chainId, this.contracts.paperStaking), type, {
      user: this.address,
      nonce: this.nonce("paper"),
      deadline,
      ...extra,
    });
    return this.send(action, intent, deadline);
  }
}
