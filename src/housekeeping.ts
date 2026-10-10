// Periodic account maintenance: stake minted PAPER, claim USDC rewards, renew session keys.

import type { WalletView } from "./api/walletStream.js";
import type { ChainReader } from "./chain/reader.js";
import type { WalletExecutor } from "./exec/executor.js";
import { logger } from "./util/log.js";
import { fromWad } from "./util/num.js";

const log = logger("housekeeping");

export interface HousekeepingSettings {
  autoStake: boolean;
  autoClaim: boolean;
  claimMinUsd: number;
  sessionTtlDays: number;
  sessionRenewDays: number;
}

export interface HousekeepingWallet {
  exec: WalletExecutor;
  view: () => WalletView | null;
}

export async function runHousekeeping(
  wallets: HousekeepingWallet[],
  chain: ChainReader,
  minimumPaperStake: bigint,
  s: HousekeepingSettings,
  nowMs = Date.now(),
): Promise<void> {
  for (const { exec, view } of wallets) {
    const v = view();
    try {
      // Session key renewal: register a fresh key well before the current one expires.
      const key = exec.sessionKey();
      if (key && key.expirySec - nowMs / 1000 < s.sessionRenewDays * 86_400 && !exec.registrationPending()) {
        log.info("renewing session key", { wallet: exec.label, expiresInH: (key.expirySec - nowMs / 1000) / 3600 });
        await exec.registerSessionKey(s.sessionTtlDays * 86_400);
      }
      if (!v) continue;
      if (s.autoStake && v.paperBalance > 0n && v.paperBalance >= minimumPaperStake) {
        log.info("staking PAPER", { wallet: exec.label, amount: fromWad(v.paperBalance) });
        await exec.stake(v.paperBalance);
      }
      if (s.autoClaim) {
        const pending = await chain.pendingReward(exec.address);
        if (pending > 0n && fromWad(pending) >= s.claimMinUsd) {
          log.info("claiming rewards", { wallet: exec.label, usd: fromWad(pending) });
          await exec.claim();
        }
      }
    } catch (err) {
      log.warn("housekeeping step failed", { wallet: exec.label, error: String(err) });
    }
  }
}
