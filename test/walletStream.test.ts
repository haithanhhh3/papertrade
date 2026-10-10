import { describe, expect, it } from "vitest";
import { WalletStream } from "../src/api/walletStream.js";

const ADDR = "0x0000000000000000000000000000000000000001";
const INTENT = "0x" + "ab".repeat(32);

const frame = {
  address: ADDR,
  indexedThroughBlock: 48040796,
  indexedThroughTimestamp: 1791509847,
  sessionKeys: [],
  walletRevision: 0,
  queueRevision: "0",
  balance: "500000000000000000000",
  queued: "0",
  locked: "0",
  funds: { reservedBalance: "0", reservedQueued: "0", availableBalance: "500000000000000000000", availableQueued: "0" },
  queueNodeCount: 0,
  consumableDebt: "0",
  paper: { balance: "0", staked: "0", pendingBase: "0", rewardDebt: "0" },
  lifetime: { depositedRaw: "0", withdrawnRaw: "0", realizedPnlRaw: "0", feesPaidRaw: "0", tradedNotionalRaw: "0", paperRewardsClaimedRaw: "0" },
  openPositions: [],
  operations: [],
  accountRevision: 1,
};

describe("WalletStream", () => {
  it("applies a full frame, then a patch with a new position, a close and an outcome", () => {
    const closed: unknown[] = [];
    const outcomes: unknown[] = [];
    const s = new WalletStream("http://x", "A", { onClosed: (c) => closed.push(...c), onOutcomes: (o) => outcomes.push(...o) });
    s.handleBlock(": connected");
    s.handleBlock(`event: liveness\ndata: {"heartbeatIntervalMs":10000}`);
    s.handleBlock(`event: wallet\ndata: ${JSON.stringify(frame)}`);
    expect(s.current()!.availableBalance).toBe(500n * 10n ** 18n);

    const open = {
      address: ADDR,
      accountRevision: 2,
      state: { funds: { reservedBalance: "0", reservedQueued: "0", availableBalance: "388000000000000000000", availableQueued: "0" } },
      addedPositions: [["7", 0, true, false, "820000", "112000000000000000000", 150, "814900", 1791600000000, INTENT]],
      removedPositionIds: [],
      addedOperations: [],
      removedOperationIds: [],
    };
    s.handleBlock(`event: wallet\ndata: ${JSON.stringify(open)}`);
    const pos = s.current()!.positions.get(7n)!;
    expect(pos.intentId).toBe(INTENT);
    expect(pos.entryPriceRaw).toBe(820000n);
    expect(s.current()!.availableBalance).toBe(388n * 10n ** 18n);

    const close = {
      address: ADDR,
      accountRevision: 3,
      state: { paper: { balance: "4939000000000000000000", staked: "0", pendingBase: "0", rewardDebt: "0" } },
      closedPositions: [["7", 0, true, "112000000000000000000", 150, false, "-50400000000000000000", "4939000000000000000000"]],
      intentOutcomes: [[INTENT, "succeeded"]],
      addedPositions: [],
      removedPositionIds: ["7"],
      addedOperations: [],
      removedOperationIds: [],
    };
    s.handleBlock(`event: wallet\ndata: ${JSON.stringify(close)}`);
    expect(s.current()!.positions.size).toBe(0);
    expect(s.current()!.paperBalance).toBe(4939n * 10n ** 18n);
    expect(closed).toHaveLength(1);
    expect((closed[0] as { netPnlRaw: bigint }).netPnlRaw).toBe(-504n * 10n ** 17n);
    expect(outcomes).toEqual([{ intentId: INTENT, outcome: "succeeded" }]);
  });

  it("ignores stale patches", () => {
    const s = new WalletStream("http://x", "A");
    s.handleBlock(`event: wallet\ndata: ${JSON.stringify({ ...frame, accountRevision: 5 })}`);
    s.handleBlock(
      `event: wallet\ndata: ${JSON.stringify({ address: ADDR, accountRevision: 4, state: {}, addedPositions: [["1", 0, true, false, "1", "1", 1, "1", 1, null]], removedPositionIds: [], addedOperations: [], removedOperationIds: [] })}`,
    );
    expect(s.current()!.positions.size).toBe(0);
  });
});
