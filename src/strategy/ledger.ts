// Spend accounting: realised net loss and PAPER minted per UTC day, plus a rolling window of
// recent pairs for the realised cost-per-PAPER circuit breaker.

import { join } from "node:path";
import { appendJsonLine, readJson, writeJsonAtomic } from "../util/fsStore.js";

interface DayStats {
  spentUsd: number;
  paper: number;
  pairs: number;
}

interface LedgerState {
  days: Record<string, DayStats>;
  recent: { costUsd: number; paper: number; at: number }[];
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export class Ledger {
  private readonly path: string;
  private readonly cyclesPath: string;
  private state: LedgerState;

  constructor(dataDir: string, private readonly window = 20) {
    this.path = join(dataDir, "ledger.json");
    this.cyclesPath = join(dataDir, "cycles.jsonl");
    this.state = readJson<LedgerState>(this.path, { days: {}, recent: [] });
  }

  /** Record a finished pair. `costUsd` is the net loss (negative when the pair made money). */
  record(costUsd: number, paper: number, at: number, detail: Record<string, unknown>): void {
    const day = utcDay(at);
    const d = (this.state.days[day] ??= { spentUsd: 0, paper: 0, pairs: 0 });
    d.spentUsd += costUsd;
    d.paper += paper;
    d.pairs += 1;
    this.state.recent.push({ costUsd, paper, at });
    if (this.state.recent.length > 200) this.state.recent.splice(0, this.state.recent.length - 200);
    writeJsonAtomic(this.path, this.state);
    appendJsonLine(this.cyclesPath, { at: new Date(at).toISOString(), costUsd, paper, ...detail });
  }

  spentToday(now: number): number {
    return this.state.days[utcDay(now)]?.spentUsd ?? 0;
  }

  today(now: number): DayStats {
    return this.state.days[utcDay(now)] ?? { spentUsd: 0, paper: 0, pairs: 0 };
  }

  /** Realised cost per PAPER over the last `window` pairs that minted something; undefined if too few. */
  rollingCostPerPaper(minPairs = 5): number | undefined {
    const recent = this.state.recent.slice(-this.window);
    if (recent.length < minPairs) return undefined;
    const cost = recent.reduce((s, r) => s + r.costUsd, 0);
    const paper = recent.reduce((s, r) => s + r.paper, 0);
    return paper > 0 ? cost / paper : Number.POSITIVE_INFINITY;
  }

  totals(): { spentUsd: number; paper: number; pairs: number } {
    return Object.values(this.state.days).reduce(
      (acc, d) => ({ spentUsd: acc.spentUsd + d.spentUsd, paper: acc.paper + d.paper, pairs: acc.pairs + d.pairs }),
      { spentUsd: 0, paper: 0, pairs: 0 },
    );
  }
}
