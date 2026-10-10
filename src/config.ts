// Bot configuration: defaults below, overridden by an optional JSON file (BOT_CONFIG, default ./config.json).
// Private keys never live in the config file: they come from the environment (see .env.example).

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((s) => s as `0x${string}`);

export const ConfigSchema = z.object({
  /** monitor: read-only, never signs. live: signs and submits intents. */
  mode: z.enum(["monitor", "live"]).default("monitor"),
  dataDir: z.string().default("./data"),
  killFile: z.string().default("./KILL"),

  exchangeUrl: z.string().url().default("https://exchange.papertrade.xyz"),
  /** X-Papertrade-Build header value; discovered from the app when unset. */
  exchangeBuildId: z.string().optional(),
  rpcUrl: z.string().url().default("https://rpc.hyperliquid.xyz/evm"),
  hlInfoUrl: z.string().url().default("https://api.hyperliquid.xyz/info"),
  chainId: z.number().int().default(999),
  contracts: z
    .object({
      exchange: address.default("0x6cd5661646289FB6E65EA5C032310fDEd797D0a2"),
      paperStaking: address.default("0xAAd6c7b0CC3014FC80FfEDAe0Ed7Ce5967b0F016"),
      tokenomics: address.default("0x75174549dbBD44497D31a47E2E2D7406408d63D9"),
      paperToken: address.default("0xe40f17915DAa230324030003A197cdAEf2261C0e"),
    })
    .default({}),

  /** Hyperliquid coin names; must match Papertrade instrument symbols. */
  assets: z.array(z.string()).default(["BTC", "ETH"]),

  budget: z
    .object({
      /** Max net USD lost per UTC day across both wallets. */
      dailyUsd: z.number().positive().default(200),
      /** Never open a pair whose modelled cost per PAPER is above this. */
      maxCostPerPaper: z.number().positive().default(0.0025),
      /** Stop opening when total equity of both wallets falls below this. */
      equityFloorUsd: z.number().nonnegative().default(200),
      /** USD kept untouched in each wallet. */
      reservePerWalletUsd: z.number().nonnegative().default(50),
      /** Front-loading when the mint rate is projected to fall: budget × (1 + kappa·urgency), capped. */
      urgencyKappa: z.number().nonnegative().default(1),
      maxFrontLoad: z.number().min(1).default(2),
      /** Pause opens when the rolling realised cost per PAPER exceeds maxCostPerPaper × this. */
      circuitBreakerMultiple: z.number().min(1).default(1.3),
      rollingWindow: z.number().int().positive().default(20),
    })
    .default({}),

  pairs: z
    .object({
      maxPairs: z.number().int().positive().default(4),
      /** Liquidation (bust) distance must be at least this multiple of the target move. */
      bustSafetyMultiple: z.number().min(1.2).default(2),
      /** Notional is sized this much above the protocol minimum. */
      notionalBuffer: z.number().min(0).default(0.1),
      /** Candidate target moves (fractions). */
      targetGrid: z.array(z.number().positive()).default([0.002, 0.003, 0.005, 0.0075, 0.01, 0.015, 0.02, 0.03]),
      /** Seconds to wait for both open intents to land before cancelling. */
      confirmTimeoutSec: z.number().positive().default(90),
      /** Close a pair that has been open longer than this multiple of its expected cycle time. */
      maxHoldMultiple: z.number().positive().default(4),
      /** Emergency close when a leg has used this fraction of its distance to bust. */
      emergencyBustFraction: z.number().gt(0).lt(1).default(0.7),
      /** Hold a leg in the same wallet as its opposite (requires protocol support). */
      singleWalletHedge: z.boolean().default(false),
      /** Expected value of a queued payout relative to an immediate one, used while the queue is active. */
      queuedPayoutValue: z.number().min(0).max(1).default(0.5),
      closeRetryLimit: z.number().int().positive().default(5),
    })
    .default({}),

  risk: z
    .object({
      maxSpreadBps: z.number().positive().default(3),
      maxMarkDivergenceBps: z.number().positive().default(10),
      maxOracleDivergenceBps: z.number().positive().default(40),
      staleQuoteSec: z.number().positive().default(5),
      /** Quotes older than this while pairs are open → close everything. */
      staleQuoteCloseSec: z.number().positive().default(60),
      staleWalletSec: z.number().positive().default(30),
      staleTradingStateSec: z.number().positive().default(20),
      /** Pause opens while the payout queue is active. */
      pauseOnQueue: z.boolean().default(false),
    })
    .default({}),

  housekeeping: z
    .object({
      intervalSec: z.number().positive().default(300),
      claimMinUsd: z.number().nonnegative().default(5),
      sessionTtlDays: z.number().positive().max(30).default(30),
      sessionRenewDays: z.number().positive().default(2),
      autoStake: z.boolean().default(true),
      autoClaim: z.boolean().default(true),
    })
    .default({}),

  loops: z
    .object({
      fastMs: z.number().int().positive().default(1000),
      slowMs: z.number().int().positive().default(30000),
      quoteMs: z.number().int().positive().default(1000),
      contextMs: z.number().int().positive().default(10000),
      candlesMs: z.number().int().positive().default(300000),
    })
    .default({}),

  /** Fallback hourly volatility (fraction) when candles are unavailable. */
  fallbackHourlyVol: z.number().positive().default(0.005),
  /** Fallback relayer latency (seconds) until measured. */
  fallbackLatencySec: z.number().positive().default(10),
});

export type Config = z.infer<typeof ConfigSchema>;

export interface Secrets {
  walletAKey?: `0x${string}`;
  walletBKey?: `0x${string}`;
}

const KEY = /^0x[0-9a-fA-F]{64}$/;

export function loadConfig(path = process.env.BOT_CONFIG ?? "./config.json"): Config {
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  return ConfigSchema.parse(raw);
}

export function loadSecrets(env: NodeJS.ProcessEnv = process.env): Secrets {
  const out: Secrets = {};
  for (const [name, field] of [
    ["PT_WALLET_A_KEY", "walletAKey"],
    ["PT_WALLET_B_KEY", "walletBKey"],
  ] as const) {
    const v = env[name]?.trim();
    if (!v) continue;
    if (!KEY.test(v)) throw new Error(`${name} must be a 0x-prefixed 32-byte hex private key`);
    out[field] = v as `0x${string}`;
  }
  return out;
}
