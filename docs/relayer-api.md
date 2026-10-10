# Relayer và API của Papertrade (chưa có doc chính thức)

Đọc từ bundle JS của `https://exchange.papertrade.xyz` ngày 2026-10-09 và kiểm tra chéo với contract. API này **không được document** và có thể đổi bất cứ lúc nào. Bot phải kiểm tra schema mỗi lần đọc và dừng khi gặp dữ liệu lạ.

## Host

| Origin | Vai trò |
|---|---|
| `https://exchange.papertrade.xyz` | Web app, API đọc, `POST /intents` (cùng origin) |
| `https://stream.papertrade.xyz` | WebSocket realtime (`/connection/websocket`, kiểu Centrifugo; có kênh `pressure:current`) |
| `https://sign.papertrade.xyz` | Iframe giữ session key của frontend (bot không cần) |
| `https://preview.papertrade.xyz` | Ảnh xem trước, không cần |

Cloudflare trả **404** cho request không có header giống trình duyệt. Phải gửi `User-Agent` của trình duyệt và `Accept: application/json` (hoặc `text/html` khi tải trang). Frontend còn gửi thêm header `X-Papertrade-Build: <build id>`.

## Endpoint đọc (GET)

| Path | Nội dung |
|---|---|
| `/ready`, `/query/ready`, `/relayer/health` | Health check, ví dụ `{"service":"relayer-intake","ready":true,...}` |
| `/state/trading` | Cấu hình giao dịch: instruments, mức tối thiểu, các action đang tạm dừng (frontend poll mỗi 1 giây) |
| `/state/user/live?wallet=<addr>` | **SSE**: ảnh chụp tài khoản (số dư, session key, vị thế mở, intent) |
| `/query/protocol/summary` | TVL, LP, hàng đợi, phí, PAPER (supply, staked, trackedLp, tailProgress, rate, ngưỡng $2M, cap $5M, S) |
| `/query/protocol/queue-summary` | Tổng hàng đợi, số mục, mục lớn nhất, mục đầu hàng |
| `/query/protocol/market-stats` | Volume 24h theo market |
| `/query/protocol/history?interval=`, `/state/house/current`, `/state/house/delta?coin=` | Chuỗi thời gian LP, PnL, hàng đợi, OI |
| `/query/protocol/trades/recent`, `/query/protocol/paper/activity` | Hoạt động gần đây |
| `/query/accounts/{addr}/funding`, `/queue-balances`, `/queue-ring`, `/portfolio-history?range=` | Lịch sử tài khoản |
| `/query/markets/{id}/price-history`, `/liquidation-map` | Dữ liệu market |
| `/state/protocol/position-topology`, `/state/leaderboard/...` | Thống kê |

### `/state/trading`

```json
{"schemaVersion":1,"indexedThroughBlock":…,"tradingPaused":false,
 "minimumTradeSizeRaw":"1e18",        // margin tối thiểu $1
 "minimumOpenNotionalRaw":"5000e18",  // notional tối thiểu $5.000
 "accRewardPerShareRaw":"0",
 "instruments":[[id,symbol,assetIndex,priceScale,active,paused,?,retired,closeOnly,
                 frozenBid,frozenAsk,pausedAtMs,rateMultiplier,positionMultiplier,maxLeverage,
                 maxPositionNotional,bustBuffer,baseRate,referenceNotional,longOi,shortOi,longCap,shortCap], …],
 "intake":[revision, minimumPaperStakeRaw, maximumNetOpenInterestRaw, [các action đang tạm dừng]]}
```

Lúc 2026-10-09 01:30 UTC: `intake = [.., 1000e18, 50_000_000e18, ["openPosition","closePositions"]]`. Nghĩa là mở và đóng lệnh đang tạm dừng (sàn chưa mở).

`priceScale`: BTC = 10, ETH = 100, tức giá raw = giá × priceScale. Mọi giá trị USD dạng `*Raw` có 18 số lẻ.

### `/state/user/live?wallet=` (SSE)

Các event: `connected`, `liveness` (`heartbeatIntervalMs: 10000`), `wallet`, `heartbeat`. Event `wallet` có dạng:

```json
{"address","indexedThroughBlock","indexedThroughTimestamp","sessionKeys":[],"walletRevision","queueRevision",
 "balance","queued","locked",
 "funds":{"reservedBalance","reservedQueued","availableBalance","availableQueued"},
 "queueNodeCount","consumableDebt",
 "paper":{"balance","staked","pendingBase","rewardDebt"},
 "lifetime":{"depositedRaw","withdrawnRaw","realizedPnlRaw","feesPaidRaw","tradedNotionalRaw","paperRewardsClaimedRaw"},
 "openPositions":[],"operations":[],"accountRevision"}
```

## Gửi intent: `POST /intents`

```
POST https://exchange.papertrade.xyz/intents
Content-Type: application/json
{"action": "<action>", "signed": { ...các trường của message (đã chuyển sang chuỗi)..., "v": "27|28", "r": "0x…", "s": "0x…" }}
```

- **Phản hồi thành công:** `{"intentId":"0x…","action":"…","state":"queued|prepared|confirmed|…","queueRevision":"…"}`. Các trạng thái có thể gặp: `queued, confirmed, failed, reverted, expired, cancelled`.
- **Huỷ intent:** `POST /intents/{intentId}/cancel`, body là CancelIntent đã ký (bỏ trường `intentId` ra khỏi body).
- **Mã lỗi:** `intake_action_paused`, `admission_rejected` (kèm `reason`), `intent_conflict`, `invalid_intent`, `deadline_expired`, `unauthorized_intent`, `intent_not_found`, `rate_limited` (HTTP 429), `below_minimum_paper_stake`, `below_minimum_withdrawal`.
- **Các `reason` của `admission_rejected`:** `tradingPaused, marketPaused, inactiveInstrument, belowMinimum, belowMinimumNotional, leverageTooHigh, positionTooLarge, openInterest, funding, noOpenPositions, paperBalance, stakedBalance, sessionKeyLimit, noDeposit, noRewards, alreadyQueued`.

### Action → kiểu ký → ai ký

| action | primaryType | Domain | Người ký |
|---|---|---|---|
| `registerSessionKey` | RegisterSessionKey | exchange | ví chính |
| `openPosition` | OpenPosition | exchange | session key |
| `closePositions` | Close | exchange | session key |
| `withdrawToCore` | WithdrawToCore | exchange | ví chính |
| `paperStake` / `paperUnstake` / `paperClaim` | Stake / Unstake / Claim | paperStaking | ví chính |
| (huỷ) | CancelIntent | cancellation | session key |

Session key bị giới hạn ở phía client: frontend từ chối ký bằng session key bất kỳ thứ gì liên quan tới withdraw, stake, claim hay register.

## EIP-712

### Domain

| Tên | name | version | verifyingContract | Đã xác minh |
|---|---|---|---|---|
| exchange | `"String"` | `"1"` | Exchange `0x6cd5…D0a2` | Có: `SessionKeyManager.DOMAIN_SEPARATOR()` khớp đúng |
| paperStaking | `"PaperStaking"` | `"1"` | PaperStaking `0xAAd6…F016` | Có: `PaperStaking.DOMAIN_SEPARATOR()` khớp |
| cancellation | `"PaperTrade Intent Cancel"` | `"2"` | Exchange | Chưa (contract không có getter) |

`chainId = 999` cho cả ba domain.

### Kiểu dữ liệu

```
RegisterSessionKey(address user,address key,uint64 expiry,address feeAddress,uint256 nonce,uint64 deadline)
OpenPosition(address user,uint32 instrumentId,bool isLong,uint128 size,uint32 leverage,bool useDebt,uint256 nonce,uint64 deadline)
Close(address user,uint256[] positionIds,uint256 nonce,uint64 deadline)
WithdrawToCore(address user,uint256 amount,uint256 nonce,uint64 deadline)
Stake(address user,uint256 amount,uint256 nonce,uint64 deadline)
Unstake(address user,uint256 amount,uint256 nonce,uint64 deadline)
Claim(address user,uint256 nonce,uint64 deadline)
CancelIntent(address user,bytes32 intentId,uint256 deadline)
```

- `size` = **margin** tính bằng USD, 18 số lẻ. Ví dụ $50 → `50e18`.
- `leverage`: số nguyên từ 1 đến maxLeverage.
- `useDebt = true`: dùng số dư đang chờ trong hàng đợi làm margin.
- `Close.positionIds`: từ 1 đến 25 phần tử, không trùng. Frontend chia nhỏ thành từng nhóm 12.
- `RegisterSessionKey.expiry`: tính bằng giây. Doc ghi session key có hạn 30 ngày (frontend dùng TTL `2592e6` ms). `feeAddress` = `0x0000…0000`.
- `deadline` = `floor(now/1000) + 3600`, tức mỗi intent có hiệu lực 1 giờ.

### Chuyển `signed` sang chuỗi

Mỗi trường được chuyển như sau: `uint*` → chuỗi thập phân; `uint256[]` → mảng chuỗi thập phân; `address`/`bytes*` → hex chữ thường; `bool` giữ nguyên. Chữ ký tách thành `v = String(27 + yParity)`, `r` và `s` là hex chữ thường.

### intentId

```
intentId = keccak256( keccak256(utf8("papertrade:intent-id:v2")) ‖ digest ‖ signer )
digest   = hashTypedData(domain, types, primaryType, message)
signer   = recoverAddress(digest, signature)   // hex chữ thường
```

Relayer trả về `intentId`; nếu không khớp với giá trị tự tính thì frontend báo lỗi.

### Nonce

- Do client tự chọn; contract có vẻ chỉ ghi nhận nonce đã dùng (cần xác minh khi chạy thật).
- Frontend chia thành 2 nhóm: **session** (`registerSessionKey`, `openPosition`, `closePositions`, `withdrawToCore`) và **paper** (`paperStake/Unstake/Claim`).
- Mỗi nhóm bắt đầu từ `random24bit × 256` rồi tăng dần 1. Giá trị được lưu vào storage theo khoá `papertrade.clientNonce.v1:<chainId>:<verifyingContract>:<nhóm>:<user>`.
- Bot nên làm giống vậy và lưu nonce xuống đĩa.

## Session key

1. Bot tự sinh một keypair secp256k1.
2. Ví chính ký `RegisterSessionKey{user, key, expiry, feeAddress:0x0, nonce, deadline}` rồi gửi `action: "registerSessionKey"`.
3. Sau đó session key ký `OpenPosition`, `Close` và `CancelIntent` với `user` = địa chỉ ví chính.
4. Huỷ session key: gọi trực tiếp `revokeSessionKey` trên SessionKeyManager từ ví chính. Đây là giao dịch HyperEVM nên cần HYPE trả gas.
5. Có giới hạn số session key trên mỗi ví (lỗi `sessionKeyLimit`).
