# Papertrade: ghi chú cơ chế

Tổng hợp ngày 2026-10-09 từ doc chính thức ([docs.papertrade.xyz](https://docs.papertrade.xyz)), contract trên HyperEVM và API của `exchange.papertrade.xyz`. Mọi tham số đều do owner chỉnh được (contract là proxy upgradeable), nên bot phải đọc lại lúc chạy, không hard-code.

## Tổng quan

- Perps tổng hợp: mọi lệnh là swap giữa user và một LP duy nhất. Không có orderbook, không matching.
- Giá vào và giá ra = BBO mid của Hyperliquid, đọc qua precompile `0x…080e` tại block thực thi lệnh. Không spread, không slippage, không funding, không phí theo notional, user không trả gas.
- Market: BTC (`instrumentId` 0, HL asset 0) và ETH (`instrumentId` 1, HL asset 1). Leverage tối đa 1000x, notional một vị thế tối đa $10M.
- Mỗi vị thế là một "slug" độc lập: margin cố định, không nạp thêm, không đóng một phần, không đổi leverage. Muốn tăng thì mở vị thế mới, muốn giảm thì đóng rồi mở lại.
- Mở, đóng, đăng ký session key và stake chỉ đi qua relayer (BatchExecutor). Mọi intent đều phải có chữ ký của ví hoặc session key, contract kiểm tra on-chain. Doc cho phép frontend bên thứ ba: tạo intent ký giống frontend rồi gửi qua relayer. Xem [`relayer-api.md`](relayer-api.md).

## Lệnh thắng: deadband → impact → phí thắng

1. **Deadband:** lời được tính như thể giá ra kém đi 0,2 bps (`entry/50000`). Lời nhỏ hơn mức đó thành 0.
2. **Impact:** `adjusted = raw × scale`, với
   ```
   scale = (1 − baseRate) / (1 + 1/(move·rateMultiplier) + referenceNotional/(1e6·move·positionMultiplier))
   move  = |exit − entry| / entry   (exit đã trừ deadband)
   ```
3. **Phí thắng:** trừ 2% trên phần lời còn lại.

Phần trăm haircut **không phụ thuộc kích thước vị thế**, chỉ phụ thuộc mức giá đã chạy.

| Tham số (on-chain) | BTC | ETH |
|---|---|---|
| baseRate | 0,10 | 0,10 |
| rateMultiplier | 15.000 | 15.000 |
| positionMultiplier | 814,598 | 483,979 |
| referenceNotional | $100.000 | $100.000 |
| bustBuffer | 4,76 bps | 4,81 bps |
| maxLeverage | 1000 | 1000 |
| maxPositionNotional | $10M | $10M |

Phần lời thực nhận trên BTC (sau deadband, impact và phí 2%):

| Giá chạy | 0,05% | 0,1% | 0,2% | 0,3% | 0,5% | 1% | 2% | 3% |
|---|---|---|---|---|---|---|---|---|
| Giữ lại | 60,7% | 72,4% | 79,7% | 82,4% | 84,6% | 86,4% | 87,3% | 87,6% |

Mức trần khi giá chạy rất xa: 0,9 × 0,98 = 88,2%.

## Lệnh thua và liquidation

- **Đóng lỗ (vốn từ số dư khả dụng):** không mất thêm gì ngoài khoản lỗ.
  - Hàng đợi rỗng: 2% phí lấy từ phần LP nhận được; PAPER mint trên `lỗ − 2%`.
  - Đang có hàng đợi: miễn phí; PAPER mint trên toàn bộ khoản lỗ; tiền vào `sideBucket` để trả hàng đợi.
- **Liquidation (hard bust):**
  - Giá bust = giá hết vốn trừ đi bustBuffer (~5 bps tính theo giá). Ví dụ ở 1000x: margin đủ cho giá chạy 0,1%, nhưng liquidate ở ~0,052%.
  - Bị liquidate là **mất toàn bộ margin**, kể cả khi tự đóng ngay trước đó vẫn còn lấy lại được một phần.
  - PAPER luôn mint trên toàn bộ margin.
  - Phí 2% chỉ thu khi hàng đợi rỗng.
  - Keeper của Papertrade chạy liquidation với priority fee cao nhất.
- **Vị thế dùng vốn từ hàng đợi (`useDebt = true`):**
  - Phần claim bị mất thì huỷ luôn; PAPER mint trên phần bị huỷ.
  - Liquidate thì huỷ toàn bộ claim, không thu phí, mint trên toàn bộ.
  - Nếu thắng, **toàn bộ** claim còn lại (margin + lời) xếp lại vào **cuối** hàng đợi.

## LP, hàng đợi FIFO, sideBucket

- **LP cash** = treasury − số dư user − margin đang khoá − phí tích luỹ. Không âm.
- **Hàng đợi:** danh sách FIFO các khoản lời chưa trả, dạng `(user, amount)`.
  - Margin không bao giờ bị xếp hàng, chỉ phần lời.
  - Khi hàng đợi khác rỗng thì `lpBankrollAvailable() = 0`: người thắng mới không được trả trước người đang chờ.
- **sideBucket:** tiền lỗ nhận vào trong lúc có hàng đợi. Keeper gọi `harvest(32)` mỗi block để trả dần hàng đợi.
- **Net LP equity** = LP cash (gồm sideBucket) − `totalQueued`. Có thể âm; đó là trạng thái "mất khả năng thanh toán tạm thời" theo thiết kế Martingaler.
- Số dư đang chờ trong hàng đợi vẫn dùng được làm margin, bằng cách mở lệnh với `useDebt = true`.

## Đường mint PAPER (PaperTokenomics)

```
trackedLpUsd < $2M (kể cả âm):  rate = 100 PAPER / $1 mint basis
trackedLpUsd ≥ $2M:             rate = 100 · (S / (S + H))²,  S = $120M,  H = tailProgressUsd
```

- `H` là mức cao nhất (high-water mark) của phần LP vượt ngưỡng; **không bao giờ giảm**, kể cả khi LP bị chuyển cho người stake.
- `trackedLpUsd` tăng theo mint basis khi có lỗ, giảm khi trả lời cho người thắng và khi chuyển phần thừa cho người stake.

| H | 0 | $3M | $10M | $25M | $50M | $100M |
|---|---|---|---|---|---|---|
| PAPER/$ | 100 | 95,2 | 85,2 | 68,5 | 49,8 | 29,8 |

## Staking

- **Nguồn lợi nhuận:**
  - Một nửa của mọi khoản phí 2% (phí thắng và phí phía LP khi thua). Chỉ trả khi hàng đợi rỗng và LP đủ tiền.
  - 100% phần trackedLp vượt $5M, chuyển qua `pushStakerFees()`.
- Stake và unstake có hiệu lực ngay, không khoá, không cooldown.
- Relayer yêu cầu stake tối thiểu 1.000 PAPER.
- Lúc mở sàn, PAPER không chuyển được giữa các ví; chỉ stake và unstake được.
- Claim cộng USDC vào số dư trên Exchange.

## Nạp và rút

- Mỗi ví có một địa chỉ nạp riêng, tính bằng CREATE2 từ DepositProxyFactory.
- Nạp tối thiểu 10 USDC; lần nạp đầu bị trừ 1 USDC phí kích hoạt.
- App chỉ cho một khoản nạp chạy tại một thời điểm.
- Chuyển ERC-20 thô thẳng vào proxy trên HyperEVM thì **không** được ghi nhận.
- Rút tối thiểu 10 USDC, cần chữ ký ví chính (`withdrawToCore` hoặc `withdrawToCoreBySig`).

## Rủi ro và quyền admin

- **Thao túng BBO:** contract không có ngắt theo độ lệch giá. Chỉ có deadband, đường impact và OI cap.
- **Pause guardian:**
  - Có thể retire một market, vĩnh viễn: giá BBO bị đóng băng, chỉ còn đóng được lệnh.
  - Có thể bật cổng chặn mở lệnh trên mọi market.
- **Owner:** chỉnh tham số, thêm market, thay keeper/relayer, nâng cấp implementation.
- **Market keeper:**
  - OI cap mỗi phía = OI hiện tại + ~$5M, chỉ cập nhật khi phần còn trống ra khỏi biên ±10%.
  - Đặt margin tối thiểu và notional tối thiểu.

## Địa chỉ contract (HyperEVM, chain 999)

Doc vẫn ghi "TBA". Các địa chỉ dưới đây do một bot bên thứ ba tìm ra on-chain. Tôi đã xác minh: tham số `instruments()` khớp doc, `PaperStaking.DOMAIN_SEPARATOR` khớp domain `"PaperStaking"`, và `SessionKeyManager.DOMAIN_SEPARATOR` khớp domain `"String"` của Exchange.

| Contract | Địa chỉ |
|---|---|
| Exchange (proxy) | `0x6cd5661646289FB6E65EA5C032310fDEd797D0a2` (impl `0x0F3feBFc94876b0C895F7aceCDc8F5c863b549EE`) |
| PaperTokenomics | `0x75174549dbBD44497D31a47E2E2D7406408d63D9` |
| PaperToken | `0xe40f17915DAa230324030003A197cdAEf2261C0e` |
| PaperStaking | `0xAAd6c7b0CC3014FC80FfEDAe0Ed7Ce5967b0F016` |
| PriceOracle | `0xa9B4c7b7Ca5835652d81E25739c870D49F39cC2e` |
| SessionKeyManager | `0x8326Eb8896e358717f10502Ec73CE8D28E37B108` |
| DepositProxyFactory | `0x1629b7D46bef6E13FF754174FC9F32dEa309b38F` |

Getter đã đọc được: `tokenomics.trackedLpUsd() / tailProgressUsd() / lpFlatThresholdUsd() / flatRate() / tailDecayScaleUsd()`, `exchange.totalQueued() / sideBucket() / treasury() / lpBankrollAvailable() / tradingPaused() / instruments(uint32) / marketOi(uint32)`, `paper.totalSupply()`, `staking.totalStaked()`. Mọi giá trị USD đều có 18 số lẻ.

## Ảnh chụp trạng thái 2026-10-09 ~01:30 UTC (trước giờ mở sàn)

- trackedLp = 0, supply PAPER = 0, hàng đợi = 0.
- Tiền đã nạp (TVL) **≈ $8,64M**.
- OI cap mỗi phía: 59,998 BTC (≈ $4,9M) và 1953,24 ETH (≈ $4,8M).
- Relayer đang **tạm dừng `openPosition` và `closePositions`** (chưa mở sàn).
- Margin tối thiểu $1, **notional tối thiểu $5.000** mỗi vị thế, net OI tối đa $50M, stake tối thiểu 1.000 PAPER.

## Thay đổi ngày 2026-10-10 (~02:30 UTC, vẫn trước giờ mở lệnh)

- **Notional tối thiểu tăng lên $10.000**, margin tối thiểu tăng lên $10.
- Tiền đã nạp ≈ $59,9M.
- OI cap được nâng lên khoảng $1 tỷ mỗi phía.
- Net OI tối đa tăng lên $250M.
- `openPosition` và `closePositions` vẫn đang tạm dừng.

Bot đọc lại các giá trị này liên tục từ `/state/trading`, không hard-code.

## Kinh tế của cặp long/short

Mở long và short cùng tài sản, cùng notional `N`, cùng giá vào. Đóng cả hai cùng lúc khi giá đã chạy `|move| = d`, khi đó lỗ của chân thua đúng bằng lời gộp của chân thắng. Gọi `keep(d)` là phần lời thực nhận (bảng ở trên). Với hàng đợi rỗng:

```
PAPER mỗi vòng       = 100 · 0,98 · N · d
chi phí ròng mỗi vòng = N · d · (1 − keep(d))
chi phí / PAPER       = (1 − keep(d)) / 98
```

Leverage **không** ảnh hưởng chi phí mỗi PAPER. Nó chỉ quyết định notional trên mỗi đồng margin (tức tốc độ) và khoảng cách tới mức bust (tức rủi ro). Để chân thua bị liquidate luôn đắt hơn tự đóng, vì mất trọn margin trong khi giá mới chạy `1/L − 5 bps`.

Bảng cho BTC, giả định dao động 2,5%/ngày, leverage chọn sao cho mức bust ≥ 2 lần target:

| Target d | $/PAPER (tự đóng) | $/PAPER (để liquidate) | Lev tối đa | 1 vòng ≈ |
|---|---|---|---|---|
| 0,1% | 0,0028 | 0,0052 | 400x | 2 phút |
| 0,3% | 0,0018 | 0,0029 | 154x | 21 phút |
| 0,5% | 0,0016 | 0,0023 | 95x | 1 giờ |
| 1% | 0,0014 | 0,0018 | 49x | 4 giờ |
| 2% | 0,0013 | 0,0015 | 25x | 15 giờ |
| 3% | 0,0013 | 0,0014 | 17x | 1,4 ngày |

- **Giá sàn ≈ $0,0012/PAPER.**
- **Trường hợp xấu nhất ≈ $0,01/PAPER:** cả hai chân đều mất, hoặc lời kẹt mãi trong hàng đợi.
- **Khi có hàng đợi:** lời của chân thắng bị xếp hàng, nên chi phí tạm thời bằng 1/E cho đến khi được trả.
- **ETH:** cùng target thì đắt hơn BTC một chút, nhưng giá chạy nhanh hơn. So cùng thời gian một vòng thì gần ngang nhau.
- **LP tăng rất ít từ người farm theo cặp:** mỗi PAPER chỉ làm trackedLp tăng khoảng $0,001–0,0014. Thời gian ở vùng 100/$ phụ thuộc chủ yếu vào khoản lỗ của trader đánh thật.

## Tham khảo: cách PaperStrategy farm

Theo [docs.paperstrategy.xyz](https://docs.paperstrategy.xyz/the-loop/acquiring-paper), mục "Acquiring PAPER":
- Họ chạy theo cặp long/short; có lúc mở lệnh một chiều để mint nhanh khi mint rate cao.
- Leverage và target quyết định tốc độ, luôn giữ khoảng an toàn trước mức liquidate.
- Khi rate sắp giảm nhanh thì chấp nhận đắt hơn để mint sớm; khi ổn định thì chạy chậm.
- Dữ liệu họ theo dõi: mint rate, tốc độ tăng LP ($/giờ), OI còn trống, đường impact, độ dao động, độ trễ relayer, hàng đợi, và chi phí mỗi PAPER thực tế.
- Họ chia vốn thành khoảng 10 account, mỗi account tối đa $10k. Các ngưỡng cụ thể được giữ kín.
