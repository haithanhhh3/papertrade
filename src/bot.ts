// Wires data sources, controller, pair manager and housekeeping into the running bot.

import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { PapertradeApi } from "./api/client.js";
import type { ProtocolSummary, TradingState } from "./api/schemas.js";
import { WalletStream, type WalletView } from "./api/walletStream.js";
import { ChainReader } from "./chain/reader.js";
import type { Config, Secrets } from "./config.js";
import { WalletExecutor } from "./exec/executor.js";
import { runHousekeeping } from "./housekeeping.js";
import { HyperliquidMarket } from "./market/hyperliquid.js";
import { impactFromInstrument } from "./model/impact.js";
import { lpVelocity } from "./model/mint.js";
import { checkGuards, type GuardResult } from "./risk/guards.js";
import { NonceStore } from "./signing/nonces.js";
import { SessionKeyStore } from "./signing/sessionKeys.js";
import { decide, type AssetInput, type Decision } from "./strategy/controller.js";
import { Ledger } from "./strategy/ledger.js";
import { PairManager } from "./strategy/pairManager.js";
import { ensureDir } from "./util/fsStore.js";
import { logger } from "./util/log.js";
import { fromWad } from "./util/num.js";

const log = logger("bot");

export interface BotWallet {
  label: string;
  address: Address;
  exec?: WalletExecutor;
  stream: WalletStream;
}

export interface BotOptions {
  /** Sign and submit intents. False = monitor only. */
  live: boolean;
  /** Free margin per wallet assumed by the controller when there are no wallets (monitor without keys). */
  assumedCapitalPerWalletUsd?: number;
}

export class Bot {
  readonly api: PapertradeApi;
  readonly market: HyperliquidMarket;
  readonly chain: ChainReader;
  readonly ledger: Ledger;
  readonly nonces: NonceStore;
  readonly sessions: SessionKeyStore;
  readonly wallets: BotWallet[] = [];
  pairs?: PairManager;

  tradingState?: TradingState;
  tradingStateAt?: number;
  summary?: ProtocolSummary;
  summaryAt?: number;
  queue?: { total: bigint; count: number };
  lastDecision?: Decision;
  lastGuards?: GuardResult;
  private lpSamples: [number, number][] = [];
  private timers: NodeJS.Timeout[] = [];
  private housekeepingBusy = false;
  private stopping = false;

  constructor(
    readonly cfg: Config,
    secrets: Secrets,
    readonly opts: BotOptions,
  ) {
    ensureDir(cfg.dataDir);
    this.api = new PapertradeApi(cfg.exchangeUrl, cfg.exchangeBuildId);
    this.market = new HyperliquidMarket(cfg.hlInfoUrl, cfg.assets);
    this.chain = new ChainReader(cfg.rpcUrl, cfg.chainId, cfg.contracts);
    this.ledger = new Ledger(cfg.dataDir, cfg.budget.rollingWindow);
    this.nonces = new NonceStore(cfg.dataDir, cfg.chainId);
    this.sessions = new SessionKeyStore(cfg.dataDir);

    const keys = [
      ["A", secrets.walletAKey],
      ["B", secrets.walletBKey],
    ] as const;
    for (const [label, key] of keys) {
      if (!key) continue;
      const account = privateKeyToAccount(key);
      const address = account.address.toLowerCase() as Address;
      const exec = new WalletExecutor(label, account, this.api, this.nonces, this.sessions, cfg.chainId, cfg.contracts);
      const stream = new WalletStream(this.api.liveUrl(address), label, {
        onUpdate: (v) => {
          exec.observeSessionKeys(v.sessionKeys);
          this.pairs?.onUpdate(label, v);
        },
        onClosed: (c) => this.pairs?.onClosed(label, c),
        onOutcomes: (o) => this.pairs?.onOutcomes(label, o),
      });
      this.wallets.push({ label, address, exec, stream });
    }
    if (opts.live) {
      if (this.wallets.length !== 2) throw new Error("live mode needs both PT_WALLET_A_KEY and PT_WALLET_B_KEY");
      this.pairs = new PairManager({
        executors: Object.fromEntries(this.wallets.map((w) => [w.label, w.exec!])),
        wallets: [this.wallets[0]!.label, this.wallets[1]!.label],
        view: (l) => this.wallet(l)?.stream.current() ?? null,
        resync: (l) => this.wallet(l)?.stream.resync(),
        quote: (s) => this.market.quote(s),
        ledger: this.ledger,
        dataDir: cfg.dataDir,
        settings: { ...cfg.pairs, strayGraceSec: 120 },
      });
    }
  }

  wallet(label: string): BotWallet | undefined {
    return this.wallets.find((w) => w.label === label);
  }

  // ---------- data refresh ----------

  async refreshTradingState(): Promise<void> {
    this.tradingState = await this.api.tradingState();
    this.tradingStateAt = Date.now();
  }

  async refreshProtocol(): Promise<void> {
    const [summary, queue] = await Promise.all([this.api.protocolSummary(), this.api.queueSummary()]);
    this.summary = summary;
    this.queue = queue;
    this.summaryAt = Date.now();
    this.lpSamples.push([this.summaryAt, fromWad(summary.paper.trackedLp)]);
    const cutoff = this.summaryAt - 2 * 3_600_000;
    this.lpSamples = this.lpSamples.filter(([t]) => t >= cutoff);
  }

  /** Tracked-LP growth (USD/hour) over the last hour of samples. */
  lpVelocityPerHour(): number {
    const cutoff = Date.now() - 3_600_000;
    return lpVelocity(this.lpSamples.filter(([t]) => t >= cutoff));
  }

  // ---------- derived state ----------

  private queueActive(): boolean {
    return (this.queue?.total ?? 0n) > 0n;
  }

  private sessionKeysValid(nowSec = Date.now() / 1000): boolean {
    if (!this.opts.live) return true;
    return this.wallets.every((w) => {
      const key = w.exec?.sessionKey();
      const onChain = key ? w.stream.current()?.sessionKeys.get(key.address) : undefined;
      return key !== undefined && onChain !== undefined && onChain > nowSec;
    });
  }

  /** Free margin per wallet: available balance minus reserve and margin of not-yet-landed opens. */
  freeMarginPerWallet(): number {
    if (!this.opts.live || this.wallets.length < 2) {
      return Math.max(0, (this.opts.assumedCapitalPerWalletUsd ?? 500) - this.cfg.budget.reservePerWalletUsd);
    }
    const free = this.wallets.map((w) => {
      const v = w.stream.current();
      if (!v) return 0;
      return fromWad(v.availableBalance) - this.cfg.budget.reservePerWalletUsd - (this.pairs?.pendingMargin(w.label) ?? 0);
    });
    return Math.max(0, Math.min(...free));
  }

  equityUsd(): number | undefined {
    if (!this.opts.live) return undefined;
    let total = 0;
    for (const w of this.wallets) {
      const v = w.stream.current();
      if (!v) return undefined;
      total += fromWad(v.availableBalance) + fromWad(v.availableQueued) + (this.pairs?.lockedMargin(w.label) ?? 0);
    }
    return total;
  }

  guards(now = Date.now()): GuardResult {
    const g = this.cfg.risk;
    const openSymbols = [...new Set(this.pairs?.active().map((p) => p.symbol) ?? [])];
    this.lastGuards = checkGuards(
      {
        now,
        tradingState: this.tradingState,
        tradingStateAt: this.tradingStateAt,
        walletAgesMs: this.opts.live ? this.wallets.map((w) => w.stream.ageMs(now)) : [],
        sessionKeysValid: this.sessionKeysValid(now / 1000),
        equityUsd: this.equityUsd(),
        queueActive: this.queueActive(),
        rollingCostPerPaper: this.ledger.rollingCostPerPaper(),
        openSymbols,
        quotes: Object.fromEntries(this.cfg.assets.map((a) => [a, this.market.quote(a)])),
        contexts: Object.fromEntries(this.cfg.assets.map((a) => [a, this.market.context(a)])),
      },
      {
        ...g,
        killFile: this.cfg.killFile,
        equityFloorUsd: this.cfg.budget.equityFloorUsd,
        maxCostPerPaper: this.cfg.budget.maxCostPerPaper,
        circuitBreakerMultiple: this.cfg.budget.circuitBreakerMultiple,
      },
      this.cfg.assets,
    );
    return this.lastGuards;
  }

  plan(guards: GuardResult, now = Date.now()): Decision | undefined {
    const ts = this.tradingState;
    const sm = this.summary;
    if (!ts || !sm) return undefined;
    const assets: AssetInput[] = [];
    for (const symbol of this.cfg.assets) {
      if (guards.assetBlockers[symbol]) continue;
      const inst = ts.instruments.find((i) => i.symbol === symbol);
      const q = this.market.quote(symbol);
      if (!inst || !q) continue;
      const headroomUnits = Math.min(fromWad(inst.longCap - inst.longOi), fromWad(inst.shortCap - inst.shortOi));
      assets.push({
        symbol,
        instrumentId: inst.id,
        impact: impactFromInstrument(inst),
        hourlyVol: this.market.vol(symbol) ?? this.cfg.fallbackHourlyVol,
        oiHeadroomUsd: Math.max(0, headroomUnits * q.mid),
      });
    }
    const trackedLp = fromWad(sm.paper.trackedLp);
    const tail = fromWad(sm.paper.tailProgress);
    const cliff = fromWad(sm.paper.cliff);
    // summary.paper.{cliff, rate, decay} are the curve parameters (lpFlatThresholdUsd, flatRate, tailDecayScaleUsd).
    const scale = fromWad(sm.paper.decay);
    const flat = fromWad(sm.paper.rate);
    const decision = decide({
      assets,
      minNotional: fromWad(ts.minimumNotional),
      minMargin: fromWad(ts.minimumMargin),
      mint: { trackedLp, tail, params: { cliff, scale, flat }, velocityPerHour: this.lpVelocityPerHour() },
      queueActive: this.queueActive(),
      budget: {
        dailyUsd: this.cfg.budget.dailyUsd,
        spentTodayUsd: this.ledger.spentToday(now),
        committedUsd: this.pairs?.committedUsd() ?? 0,
        openSpendPerHour: this.pairs?.openSpendPerHour() ?? 0,
      },
      freeMarginUsd: this.freeMarginPerWallet(),
      openPairs: this.pairs?.active().length ?? 0,
      latencySec: this.pairs?.latencyP90() ?? this.cfg.fallbackLatencySec,
      settings: { ...this.cfg.pairs, ...this.cfg.budget },
    });
    this.lastDecision = decision;
    return decision;
  }

  // ---------- loops ----------

  async start(): Promise<void> {
    log.info("starting", { mode: this.opts.live ? "live" : "monitor", wallets: this.wallets.map((w) => ({ label: w.label, address: w.address })) });
    this.market.start(this.cfg.loops);
    for (const w of this.wallets) w.stream.start();
    await Promise.allSettled([this.refreshTradingState(), this.refreshProtocol()]);
    const every = (ms: number, name: string, fn: () => Promise<void> | void) => {
      const t = setInterval(async () => {
        try {
          await fn();
        } catch (err) {
          log.warn(`${name} failed`, { error: String(err) });
        }
      }, ms);
      this.timers.push(t);
    };
    every(5000, "trading-state", () => this.refreshTradingState());
    every(this.cfg.loops.slowMs, "protocol", () => this.refreshProtocol());
    every(this.cfg.loops.fastMs, "fast", () => this.fastTick());
    every(this.cfg.loops.slowMs, "slow", () => this.slowTick());
    if (this.opts.live) every(this.cfg.housekeeping.intervalSec * 1000, "housekeeping", () => this.housekeepingTick());
    // First decision soon after start instead of waiting a full slow interval.
    const first = setTimeout(() => void this.slowTick().catch((err) => log.warn("slow failed", { error: String(err) })), 5000);
    this.timers.push(first);
  }

  private fastTick(): void {
    const g = this.guards();
    if (g.closeAllReason && this.pairs?.active().length) this.pairs.closeAll(g.closeAllReason);
    this.pairs?.tick();
    if (g.killed && this.pairs && this.pairs.active().length === 0 && !this.stopping) {
      log.warn("kill switch: all pairs closed, stopping");
      void this.stop().then(() => process.exit(0));
    }
  }

  private async slowTick(): Promise<void> {
    const g = this.lastGuards ?? this.guards();
    const d = this.plan(g);
    const today = this.ledger.today(Date.now());
    log.info("tick", {
      rate: d?.mintRateNow,
      rate24h: d?.mintRate24h,
      trackedLp: this.summary ? fromWad(this.summary.paper.trackedLp) : undefined,
      lpPerHour: Math.round(this.lpVelocityPerHour()),
      queueUsd: this.queue ? fromWad(this.queue.total) : undefined,
      spentToday: today.spentUsd,
      paperToday: today.paper,
      openPairs: this.pairs?.active().length ?? 0,
      blockers: g.blockers,
      assetBlockers: g.assetBlockers,
      decision: d ? { action: d.action, reason: d.reason, choice: summarize(d) } : undefined,
    });
    if (!this.opts.live || !this.pairs || !d || d.action !== "open" || !d.choice) return;
    if (g.blockers.length) return;
    if (this.pairs.hasOpening()) return; // one pair at a time
    const c = d.choice;
    const inst = this.tradingState?.instruments.find((i) => i.id === c.instrumentId);
    if (!inst) return;
    await this.pairs.openPair({
      symbol: c.symbol,
      instrumentId: c.instrumentId,
      priceScale: inst.priceScale,
      target: c.target,
      leverage: c.leverage,
      marginUsd: c.marginPerLeg,
      expectedCycleHours: c.cycleHours,
      expectedCostUsd: c.costPerCycle,
      expectedSpendPerHour: c.spendPerHour,
    });
  }

  private async housekeepingTick(): Promise<void> {
    if (this.housekeepingBusy || !this.tradingState) return;
    this.housekeepingBusy = true;
    try {
      await runHousekeeping(
        this.wallets.filter((w) => w.exec).map((w) => ({ exec: w.exec!, view: () => w.stream.current() })),
        this.chain,
        this.tradingState.minimumPaperStake,
        this.cfg.housekeeping,
      );
    } finally {
      this.housekeepingBusy = false;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.market.stop();
    for (const w of this.wallets) w.stream.stop();
  }

  views(): { label: string; address: string; view: WalletView | null }[] {
    return this.wallets.map((w) => ({ label: w.label, address: w.address, view: w.stream.current() }));
  }
}

export function summarize(d: Decision): Record<string, unknown> | undefined {
  const c = d.choice;
  if (!c) return undefined;
  return {
    symbol: c.symbol,
    targetPct: +(c.target * 100).toFixed(3),
    leverage: c.leverage,
    marginPerLeg: c.marginPerLeg,
    notional: Math.round(c.notional),
    costPerPaper: +c.costPerPaper.toFixed(5),
    cycleMin: +(c.cycleHours * 60).toFixed(1),
    spendPerHour: +c.spendPerHour.toFixed(2),
    paperPerHour: Math.round(c.paperPerHour),
    pairsWanted: c.pairs,
  };
}
