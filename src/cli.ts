#!/usr/bin/env node
// Command-line entry point. See README for the full run guide.

import { writeFileSync } from "node:fs";
import { Bot, summarize } from "./bot.js";
import { loadConfig, loadSecrets } from "./config.js";
import { logger } from "./util/log.js";
import { fromWad } from "./util/num.js";

const log = logger("cli");

const HELP = `ptbot <command>

  monitor     Read-only: stream market/protocol data and log what the controller would do.
  plan        One-shot: print the controller's ranked candidates right now.
  status      One-shot: protocol state, wallet balances, PAPER, open positions, ledger.
  register    Generate and register a session key for each wallet (main wallet signs).
  run         Live trading (requires "mode": "live" in config.json and both wallet keys).
  stake       Stake all unstaked PAPER in both wallets now.
  claim       Claim USDC staking rewards in both wallets now.
  kill        Create the kill file: the running bot closes every pair and exits.

Environment: PT_WALLET_A_KEY, PT_WALLET_B_KEY (0x… private keys), BOT_CONFIG (default ./config.json).`;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(500);
  }
  return cond();
}

async function snapshotBot(live: boolean): Promise<Bot> {
  const bot = new Bot(loadConfig(), loadSecrets(), { live });
  for (const w of bot.wallets) w.stream.start();
  await Promise.all([bot.refreshTradingState(), bot.refreshProtocol()]);
  // Market data is best effort here (Hyperliquid may rate-limit); missing quotes show up as asset blockers.
  const market = await Promise.allSettled([
    ...bot.cfg.assets.flatMap((a) => [bot.market.refreshQuote(a), bot.market.refreshVol(a)]),
    bot.market.refreshContexts(),
  ]);
  for (const r of market) if (r.status === "rejected") log.warn("market data unavailable", { error: String(r.reason) });
  await waitFor(() => bot.wallets.every((w) => w.stream.current() !== null), 15_000);
  return bot;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const cfg = loadConfig();

  switch (cmd) {
    case "monitor": {
      const bot = new Bot(cfg, loadSecrets(), { live: false });
      await bot.start();
      const stop = () => void bot.stop().then(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }

    case "run": {
      if (cfg.mode !== "live") throw new Error('refusing to trade: set "mode": "live" in config.json (or use `monitor`)');
      const bot = new Bot(cfg, loadSecrets(), { live: true });
      await bot.start();
      // Pairs are hedged, so a restart does not need to close them: on SIGINT/SIGTERM we stop the loops
      // and leave positions to be re-adopted from data/pairs.json on the next start.
      const stop = () => void bot.stop().then(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }

    case "plan": {
      const bot = await snapshotBot(false);
      const g = bot.guards();
      const d = bot.plan(g);
      console.log(JSON.stringify({ blockers: g.blockers, assetBlockers: g.assetBlockers }, null, 2));
      if (d) {
        console.log(`mint rate now ${d.mintRateNow.toFixed(2)} PAPER/$, in 24h ${d.mintRate24h.toFixed(2)}; urgency ${(d.urgency * 100).toFixed(1)}%`);
        console.log(`allowance $${d.allowanceUsd.toFixed(2)}/day, left $${d.budgetLeftUsd.toFixed(2)}, target spend $${d.targetSpendPerHour.toFixed(2)}/h`);
        console.log(`decision: ${d.action} (${d.reason})`, JSON.stringify(summarize(d)));
        console.table(
          d.ranked.map((c) => ({
            asset: c.symbol,
            "target%": +(c.target * 100).toFixed(2),
            lev: c.leverage,
            margin: c.marginPerLeg,
            notional: Math.round(c.notional),
            "keep%": +(c.keep * 100).toFixed(1),
            "$/PAPER": +c.costPerPaper.toFixed(5),
            "cycle(min)": +(c.cycleHours * 60).toFixed(1),
            "$/h/pair": +c.spendPerHour.toFixed(2),
            pairs: c.pairs,
            "PAPER/h": Math.round(c.score),
          })),
        );
      }
      await bot.stop();
      return;
    }

    case "status": {
      const bot = await snapshotBot(false);
      const sm = bot.summary!;
      console.log(
        `protocol: TVL $${fromWad(sm.balances.tvl).toFixed(0)}, trackedLp $${fromWad(sm.paper.trackedLp).toFixed(0)}, ` +
          `queue $${fromWad(bot.queue?.total ?? 0n).toFixed(2)} (${bot.queue?.count ?? 0}), PAPER supply ${fromWad(sm.paper.supply).toFixed(0)}, staked ${fromWad(sm.paper.staked).toFixed(0)}`,
      );
      console.log(`relayer paused actions: ${[...(bot.tradingState?.pausedActions ?? [])].join(", ") || "none"}`);
      for (const { label, address, view } of bot.views()) {
        if (!view) {
          console.log(`wallet ${label} ${address}: no data`);
          continue;
        }
        const key = bot.wallets.find((w) => w.label === label)?.exec?.sessionKey();
        const keyExpiry = key ? view.sessionKeys.get(key.address) : undefined;
        console.log(
          `wallet ${label} ${address}: available $${fromWad(view.availableBalance).toFixed(2)}, queued $${fromWad(view.availableQueued).toFixed(2)}, ` +
            `PAPER ${fromWad(view.paperBalance).toFixed(0)} (+${fromWad(view.paperStaked).toFixed(0)} staked), positions ${view.positions.size}, ` +
            `session key ${key ? (keyExpiry ? `registered until ${new Date(keyExpiry * 1000).toISOString()}` : "NOT registered") : "none"}`,
        );
      }
      const t = bot.ledger.totals();
      console.log(`ledger: ${t.pairs} pairs, spent $${t.spentUsd.toFixed(2)}, PAPER ${t.paper.toFixed(0)}, avg $/PAPER ${t.paper ? (t.spentUsd / t.paper).toFixed(5) : "-"}`);
      await bot.stop();
      return;
    }

    case "register": {
      const bot = await snapshotBot(false);
      const ttl = cfg.housekeeping.sessionTtlDays * 86_400;
      for (const w of bot.wallets) {
        const existing = w.exec!.sessionKey();
        const onChain = existing ? w.stream.current()?.sessionKeys.get(existing.address) : undefined;
        if (existing && onChain && onChain - Date.now() / 1000 > cfg.housekeeping.sessionRenewDays * 86_400) {
          log.info("session key already registered", { wallet: w.label, key: existing.address, expires: new Date(onChain * 1000).toISOString() });
          continue;
        }
        const { key, result } = await w.exec!.registerSessionKey(ttl);
        log.info("registration submitted", { wallet: w.label, key: key.address, intentId: result.intentId, state: result.accepted?.state });
        const ok = await waitFor(() => w.stream.current()?.sessionKeys.has(key.address) === true, 120_000);
        if (ok) log.info("session key registered", { wallet: w.label, key: key.address });
        else log.warn("session key not visible yet; check `status` in a minute", { wallet: w.label, key: key.address });
      }
      await bot.stop();
      return;
    }

    case "stake":
    case "claim": {
      const bot = await snapshotBot(false);
      for (const w of bot.wallets) {
        const v = w.stream.current();
        if (cmd === "stake") {
          if (!v || v.paperBalance === 0n) continue;
          if (v.paperBalance < (bot.tradingState?.minimumPaperStake ?? 0n)) {
            log.info("below minimum stake", { wallet: w.label, paper: fromWad(v.paperBalance) });
            continue;
          }
          await w.exec!.stake(v.paperBalance);
        } else {
          const pending = await bot.chain.pendingReward(w.address);
          if (pending === 0n) continue;
          await w.exec!.claim();
        }
      }
      await bot.stop();
      return;
    }

    case "kill": {
      writeFileSync(cfg.killFile, new Date().toISOString() + "\n");
      console.log(`kill file written to ${cfg.killFile}; the running bot will close all pairs and exit. Delete it before restarting.`);
      return;
    }

    default:
      console.log(HELP);
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((err) => {
  log.error("fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
