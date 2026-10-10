// zod schemas for the (undocumented) Papertrade API. Shapes were read from the official frontend bundle;
// every response is validated so a server-side change stops the bot instead of feeding it garbage.

import { z } from "zod";

const uint = z.string().regex(/^\d+$/).transform((s) => BigInt(s));
const int = z.string().regex(/^-?\d+$/).transform((s) => BigInt(s));
const intentId = z.string().regex(/^0x[0-9a-f]{64}$/);
const wallet = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((s) => s.toLowerCase() as `0x${string}`);

// ---------- /state/trading ----------

export const InstrumentSchema = z
  .tuple([
    z.number().int(), // id
    z.string(), // symbol
    z.number().int(), // HL asset index
    z.string().regex(/^\d+$/), // price scale
    z.boolean(), // active
    z.boolean(), // paused
    z.boolean(), // (unused flag)
    z.boolean(), // retired
    z.boolean(), // closeOnly
    z.string().nullable(), // frozen bid
    z.string().nullable(), // frozen ask
    z.number().nullable(), // paused at ms
    uint, // rateMultiplier (wad)
    uint, // positionMultiplier (wad)
    z.number().int(), // max leverage
    uint, // max position notional (wad)
    uint, // bust buffer (wad fraction)
    uint, // base rate (wad fraction)
    uint, // reference notional (wad)
    uint, // long OI (asset units, wad)
    uint, // short OI
    uint, // long cap
    uint, // short cap
  ])
  .transform((t) => ({
    id: t[0],
    symbol: t[1],
    assetIndex: t[2],
    priceScale: Number(t[3]),
    active: t[4],
    paused: t[5],
    retired: t[7],
    closeOnly: t[8],
    openable: t[4] && !t[5] && !t[7] && !t[8],
    rateMultiplier: t[12],
    positionMultiplier: t[13],
    maxLeverage: t[14],
    maxPositionNotional: t[15],
    bustBuffer: t[16],
    baseRate: t[17],
    referenceNotional: t[18],
    longOi: t[19],
    shortOi: t[20],
    longCap: t[21],
    shortCap: t[22],
  }));

export type Instrument = z.output<typeof InstrumentSchema>;

export const TradingStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    indexedThroughBlock: z.number().int(),
    tradingPaused: z.boolean(),
    minimumTradeSizeRaw: uint,
    minimumOpenNotionalRaw: uint,
    accRewardPerShareRaw: uint,
    instruments: z.array(InstrumentSchema),
    intake: z.tuple([z.number(), uint, uint, z.array(z.string())]),
  })
  .transform((s) => ({
    indexedThroughBlock: s.indexedThroughBlock,
    tradingPaused: s.tradingPaused,
    minimumMargin: s.minimumTradeSizeRaw,
    minimumNotional: s.minimumOpenNotionalRaw,
    instruments: s.instruments,
    minimumPaperStake: s.intake[1],
    maximumNetOpenInterest: s.intake[2],
    pausedActions: new Set(s.intake[3]),
  }));

export type TradingState = z.output<typeof TradingStateSchema>;

// ---------- /query/protocol/summary ----------

export const ProtocolSummarySchema = z.object({
  ok: z.literal(true),
  source: z.object({ block: z.string(), at: z.number() }).passthrough(),
  balances: z.object({ tvl: uint, margin: uint, lp: int, reserve: int, queue: uint }),
  activity: z.object({ volume: uint, open: z.number().int() }),
  fees: z.object({ pending: uint, lifetime: uint }),
  paper: z
    .object({
      supply: uint,
      staked: uint,
      trackedLp: int,
      tailProgress: uint,
      cliff: uint,
      cap: uint,
      rate: uint,
      decay: uint,
    })
    .passthrough(),
});

export type ProtocolSummary = z.output<typeof ProtocolSummarySchema>;

export const QueueSummarySchema = z
  .object({ ok: z.literal(true), total: uint, count: z.number().int() })
  .passthrough();

// ---------- /state/user/live (SSE "wallet" events) ----------

export const PositionSchema = z
  .tuple([
    z.string().regex(/^\d+$/), // position id
    z.number().int(), // instrument id
    z.boolean(), // isLong
    z.boolean(), // useDebt
    z.string().regex(/^\d+$/), // entry price raw (price × priceScale)
    z.string().regex(/^\d+$/), // margin (wad)
    z.number().int(), // leverage
    z.string().regex(/^\d+$/), // bust price raw
    z.number(), // opened at ms
    intentId.nullable(),
  ])
  .transform((t) => ({
    positionId: BigInt(t[0]),
    instrumentId: t[1],
    isLong: t[2],
    useDebt: t[3],
    entryPriceRaw: BigInt(t[4]),
    marginRaw: BigInt(t[5]),
    leverage: t[6],
    bustPriceRaw: BigInt(t[7]),
    openedAtMs: t[8],
    intentId: t[9],
  }));

export type Position = z.output<typeof PositionSchema>;

export const ClosedPositionSchema = z
  .tuple([
    z.string().regex(/^\d+$/),
    z.number().int(),
    z.boolean(),
    z.string().regex(/^\d+$/),
    z.number().int(),
    z.boolean(), // liquidated
    z.string().regex(/^-?\d+$/), // net pnl (wad, signed)
    z.string().regex(/^\d+$/), // PAPER minted (wad)
  ])
  .transform((t) => ({
    positionId: BigInt(t[0]),
    instrumentId: t[1],
    isLong: t[2],
    marginRaw: BigInt(t[3]),
    leverage: t[4],
    liquidated: t[5],
    netPnlRaw: BigInt(t[6]),
    paperMintedRaw: BigInt(t[7]),
  }));

export type ClosedPosition = z.output<typeof ClosedPositionSchema>;

const ACTIONS = [
  "openPosition",
  "closePositions",
  "withdrawToCore",
  "registerSessionKey",
  "paperStake",
  "paperUnstake",
  "paperClaim",
  "paperDistribute",
] as const;

export const OperationSchema = z
  .tuple([
    intentId,
    z.enum(ACTIONS),
    z.number().int().nullable(),
    z.boolean().nullable(),
    z.boolean().nullable(),
    z.string().regex(/^\d+$/).nullable(),
    z.number().int().nullable(),
    z.number(),
    z.union([z.string(), z.number()]),
    z.array(z.string()).nullable(),
  ])
  .transform((t) => ({ intentId: t[0], action: t[1], acceptedAtMs: t[7] }));

export type Operation = z.output<typeof OperationSchema>;

export const IntentOutcomeSchema = z
  .tuple([intentId, z.enum(["succeeded", "failed", "expired", "cancelled", "unknown"])])
  .transform((t) => ({ intentId: t[0], outcome: t[1] }));

export type IntentOutcome = z.output<typeof IntentOutcomeSchema>;

const WalletStateFields = {
  indexedThroughBlock: z.number(),
  walletRevision: z.number(),
  indexedThroughTimestamp: z.number(),
  sessionKeys: z.array(z.tuple([wallet, z.union([z.string(), z.number()])])),
  queueRevision: z.string(),
  balance: uint,
  queued: uint,
  locked: uint,
  funds: z.object({ reservedBalance: uint, reservedQueued: uint, availableBalance: uint, availableQueued: uint }),
  queueNodeCount: z.number(),
  consumableDebt: uint,
  paper: z.object({ balance: uint, staked: uint, pendingBase: uint, rewardDebt: uint }),
};

export const WalletFrameSchema = z.object({
  address: wallet,
  accountRevision: z.number(),
  ...WalletStateFields,
  openPositions: z.array(PositionSchema),
  operations: z.array(OperationSchema),
});

export const WalletPatchSchema = z.object({
  address: wallet,
  accountRevision: z.number(),
  state: z.object(WalletStateFields).partial(),
  closedPositions: z.array(ClosedPositionSchema).optional(),
  intentOutcomes: z.array(IntentOutcomeSchema).optional(),
  addedPositions: z.array(PositionSchema),
  removedPositionIds: z.array(z.string().regex(/^\d+$/)),
  addedOperations: z.array(OperationSchema),
  removedOperationIds: z.array(intentId),
});

export type WalletFrame = z.output<typeof WalletFrameSchema>;
export type WalletPatch = z.output<typeof WalletPatchSchema>;

// ---------- POST /intents ----------

export const IntentAcceptedSchema = z
  .object({
    intentId,
    action: z.string(),
    state: z.string(),
    queueRevision: z.string().optional(),
  })
  .passthrough();

export type IntentAccepted = z.output<typeof IntentAcceptedSchema>;
