// Pre-trade and in-trade safety checks. `canOpen` gates new pairs; `mustCloseAll` forces exits.

import { existsSync } from "node:fs";
import type { TradingState } from "../api/schemas.js";
import type { AssetContext, Quote } from "../market/hyperliquid.js";

export interface GuardSettings {
  killFile: string;
  maxSpreadBps: number;
  maxMarkDivergenceBps: number;
  maxOracleDivergenceBps: number;
  staleQuoteSec: number;
  staleQuoteCloseSec: number;
  staleWalletSec: number;
  staleTradingStateSec: number;
  pauseOnQueue: boolean;
  equityFloorUsd: number;
  maxCostPerPaper: number;
  circuitBreakerMultiple: number;
}

export interface GuardInput {
  now: number;
  tradingState?: TradingState;
  tradingStateAt?: number;
  walletAgesMs: number[];
  sessionKeysValid: boolean;
  equityUsd?: number;
  queueActive: boolean;
  rollingCostPerPaper?: number;
  /** Symbols that currently have open pairs (their quotes must stay fresh). */
  openSymbols: string[];
  quotes: Record<string, Quote | undefined>;
  contexts: Record<string, AssetContext | undefined>;
}

export interface GuardResult {
  /** Global reasons that block any new pair. */
  blockers: string[];
  /** Assets that are individually unsafe to open on, with the reason. */
  assetBlockers: Record<string, string>;
  /** Set when every open pair must be closed now. */
  closeAllReason?: string;
  /** Kill switch present: close everything and stop. */
  killed: boolean;
}

export function checkGuards(input: GuardInput, s: GuardSettings, assets: string[]): GuardResult {
  const blockers: string[] = [];
  const assetBlockers: Record<string, string> = {};
  const killed = existsSync(s.killFile);
  let closeAllReason: string | undefined;
  if (killed) {
    blockers.push("kill switch");
    closeAllReason = "kill switch";
  }

  const ts = input.tradingState;
  if (!ts || !input.tradingStateAt) blockers.push("trading state unavailable");
  else {
    if (input.now - input.tradingStateAt > s.staleTradingStateSec * 1000) blockers.push("trading state stale");
    if (ts.tradingPaused) blockers.push("trading paused");
    if (ts.pausedActions.has("openPosition")) blockers.push("relayer paused openPosition");
    if (ts.pausedActions.has("closePositions")) blockers.push("relayer paused closePositions");
  }
  if (input.walletAgesMs.some((a) => a > s.staleWalletSec * 1000)) blockers.push("wallet stream stale");
  if (!input.sessionKeysValid) blockers.push("session key missing or not registered");
  if (input.equityUsd !== undefined && input.equityUsd < s.equityFloorUsd) blockers.push(`equity ${input.equityUsd.toFixed(2)} below floor`);
  if (s.pauseOnQueue && input.queueActive) blockers.push("payout queue active");
  if (input.rollingCostPerPaper !== undefined && input.rollingCostPerPaper > s.maxCostPerPaper * s.circuitBreakerMultiple) {
    blockers.push(`realised cost/PAPER ${input.rollingCostPerPaper.toFixed(5)} above circuit breaker`);
  }

  for (const coin of assets) {
    const q = input.quotes[coin];
    const inst = ts?.instruments.find((i) => i.symbol === coin);
    if (!inst) {
      assetBlockers[coin] = "instrument not listed";
      continue;
    }
    if (!inst.openable) assetBlockers[coin] = "instrument not openable";
    if (!q) {
      assetBlockers[coin] ??= "no quote";
      continue;
    }
    const age = input.now - q.at;
    if (age > s.staleQuoteSec * 1000) assetBlockers[coin] ??= "quote stale";
    if (q.spreadBps > s.maxSpreadBps) assetBlockers[coin] ??= `spread ${q.spreadBps.toFixed(2)} bps`;
    const ctx = input.contexts[coin];
    if (ctx) {
      const markDiv = (Math.abs(q.mid - ctx.mark) / ctx.mark) * 1e4;
      const oracleDiv = (Math.abs(q.mid - ctx.oracle) / ctx.oracle) * 1e4;
      if (markDiv > s.maxMarkDivergenceBps) assetBlockers[coin] ??= `mid/mark divergence ${markDiv.toFixed(1)} bps`;
      if (oracleDiv > s.maxOracleDivergenceBps) assetBlockers[coin] ??= `mid/oracle divergence ${oracleDiv.toFixed(1)} bps`;
    } else assetBlockers[coin] ??= "no mark/oracle";
  }
  for (const coin of input.openSymbols) {
    const q = input.quotes[coin];
    if (!q || input.now - q.at > s.staleQuoteCloseSec * 1000) closeAllReason ??= `${coin} quotes stale while pairs are open`;
  }

  return { blockers, assetBlockers, closeAllReason, killed };
}
