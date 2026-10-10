# Thiết kế bot farm PAPER

Trạng thái: **đã cài đặt** (`src/`). Hướng dẫn chạy xem README. Cơ chế protocol xem ở [`protocol.md`](protocol.md), API relayer ở [`relayer-api.md`](relayer-api.md).

## Mục tiêu

- Tự động mint PAPER bằng các cặp long/short trên 2 ví hedge nhau, với chi phí mỗi PAPER thấp nhất trong giới hạn ngân sách.
- Tự điều chỉnh tốc độ theo mint rate, tốc độ tăng LP, hàng đợi, độ dao động và độ trễ relayer.
- Tự stake PAPER, tự claim USDC, tự gia hạn session key.
- Không bao giờ để một chân nằm hở mà không có giám sát.

**Không làm:** trade có hướng để kiếm lời, thao túng BBO, đi vòng qua relayer.

## Giả định đầu vào

- 2 ví mới, mỗi ví **$500** do người dùng tự nạp. Key ví chính lưu trên server của bot.
- **Ví A giữ chân long, ví B giữ chân short** (có thể đảo vai theo từng cặp).
- Mỗi vị thế phải có notional ≥ mức tối thiểu của sàn (đọc từ `/state/trading`, hiện là $10.000), mỗi ví giữ lại $50 dự phòng.

## Stack

**TypeScript (strict) trên Node 22 LTS** (đã chọn), gồm:
- `viem`: ký EIP-712 và đọc RPC. Frontend chính thức cũng dùng viem/wagmi, nên cách hash typed data và tính intentId giống hệt.
- `zod`: kiểm tra schema của mọi phản hồi API. Frontend cũng dùng zod.
- File JSON ghi nguyên tử (`data/`): trạng thái các cặp, nonce, session key, sổ ngân sách; `data/cycles.jsonl` ghi từng cặp đã đóng. Không cần module native.
- Logger JSON tự viết: mỗi dòng một object, hợp với journald.
- WebSocket có sẵn của Node: kênh `bbo` của Hyperliquid làm nguồn giá chính, REST làm dự phòng.
- SSE client cho `/state/user/live`.
- `vitest`: unit test.

Chạy một tiến trình duy nhất bằng `systemd`. Key nằm trong `.env` (chmod 600), không bao giờ commit.

## Kiến trúc

```
src/
  config.ts            tham số + giới hạn rủi ro (đọc từ file/env)
  chain/               viem client, đọc PaperTokenomics / Exchange / Staking
  api/                 relayer client (POST /intents, cancel), /state/trading, SSE /state/user/live
  signing/             typed data, chuyển trường sang chuỗi, intentId, kho nonce (theo nhóm)
  market/              Hyperliquid: BBO/mid realtime, nến 1 phút, mark/oracle
  model/               keep(d), đường mint, chi phí/PAPER, ước thời gian một vòng
  strategy/
    controller.ts      bộ điều khiển tốc độ (chọn tài sản, target, leverage, margin, số cặp)
    pair.ts            máy trạng thái của một cặp
  risk/                kill switch, ngân sách, kiểm tra dữ liệu cũ / spread / oracle, xử lý pause
  housekeeping/        stake, claim, gia hạn session key, cảnh báo lệch số dư
  store/               SQLite
  index.ts             vòng nhanh (1s) + vòng chậm (30s) + vòng định kỳ (5 phút)
test/                  model, typed data/intentId, máy trạng thái (relayer giả)
```

## Vòng đời một cặp

```
IDLE → OPENING → OPEN → CLOSING → CLOSED
          │         │        └─(lỗi)→ thử lại / báo động
          └─(một chân hỏng)→ ORPHAN → đóng chân còn lại ngay
```

1. **OPENING:**
   - Gửi đồng thời `OpenPosition` cho ví A (long) và ví B (short): cùng instrument, cùng margin, cùng leverage.
   - Chờ xác nhận qua SSE trong thời gian `T_confirm` (mặc định 60 giây).
   - Nếu một chân hỏng, hết hạn hoặc quá thời gian: huỷ intent còn treo (`CancelIntent`), đóng chân đã khớp, chuyển sang ORPHAN.
2. **OPEN:**
   - Ghi lại giá vào của từng chân. Nếu hai giá khác nhau thì phần chênh được tính vào ngưỡng đóng.
   - Mỗi giây tính `move = mid/entry − 1` từ BBO của Hyperliquid.
3. **Điều kiện đóng:**
   - `|move| ≥ d_target`, hoặc
   - giữ quá lâu (`hold > 4·τ(d)`), hoặc
   - **khẩn cấp:** `|move| ≥ 0,7 × khoảng cách tới bust`, market bị pause/retire, hoặc có lệnh kill.
4. **CLOSING:**
   - Gửi `Close` cho cả 2 ví cùng lúc.
   - Thử lại khi lỗi tạm thời; quá N lần thì báo động.
5. **CLOSED:** ghi lại khoản lỗ, phần lời thực nhận, số PAPER mint (chênh `paper.balance` trên SSE) và chi phí mỗi PAPER thực tế. Dùng số liệu này để hiệu chỉnh `keep(d)` so với công thức.
6. **Bị liquidate ngoài ý muốn** (vị thế biến mất mà bot không đóng): đóng chân kia ngay và ghi lại sự cố.
7. **Khởi động lại:** đọc lại các vị thế đang mở từ SSE và ghép cặp lại trước khi làm việc khác.

**Chế độ một ví (tuỳ chọn):** relayer không có lý do từ chối nào cấm hedge trong cùng một ví. Nếu thử thật thấy được phép, một intent `Close` có thể đóng **cả 2 chân trong cùng một lệnh**, đảm bảo cùng giá. Bot sẽ hỗ trợ cả hai chế độ.

## Bộ điều khiển tốc độ (vòng chậm, mỗi 30 giây)

### Đầu vào

- **Mint rate** `E` và các thành phần trackedLp, tailProgress (`/query/protocol/summary`, đối chiếu với `PaperTokenomics`).
- **Tốc độ tăng LP** `v_LP` ($/giờ): EMA trên 15 phút và 2 giờ. Thêm tốc độ tăng supply PAPER.
- **Hàng đợi:** tổng, số mục, xu hướng; `sideBucket`.
- **Thị trường:** σ của từng tài sản (EWMA lợi suất 1 phút trên 1–4 giờ), spread, độ lệch giữa mid và mark/oracle trên Hyperliquid.
- **Độ trễ relayer:** p50/p95 từ lúc gửi tới lúc xác nhận, đo trên chính các intent của bot. Thêm kênh `pressure`.
- **Giới hạn:** OI còn trống mỗi phía, mức tối thiểu (`/state/trading`), số dư khả dụng của từng ví.

### Mô hình

- `keep(d)` theo công thức impact on-chain (deadband → scale → phí 2%).
- `L(d) = min(maxLev, floor(1 / (k·d + bustBuffer + m_lat)))`, với `k = 2` và `m_lat = σ·√(p95 latency)`.
- `M_min(d) = 1,1 × minNotional / L(d)`: margin tối thiểu để notional vượt mức tối thiểu của sàn 10%. Margin mỗi chân = max(vốn trống chia đều cho số slot, M_min), không vượt vốn trống.
- `τ(d) ≈ (d/σ)² + latency`: thời gian kỳ vọng để giá chạm ±d.
- `c(d) = (1 − q·keep(d)) / (E_proj · f)`:
  - `f = 0,98` khi hàng đợi rỗng, `f = 1` khi đang có hàng đợi.
  - `q` = hệ số chiết khấu cho khả năng lời được trả sớm: 1 khi hàng đợi rỗng, nhỏ hơn 1 khi đang có hàng đợi.
- `E_proj = E(trackedLp + v_LP·τ)` theo đường mint.

### Quyết định

1. **Mức độ gấp:** `u = max(0, (E_now − E_proj(24h)) / E_now)`. Nghĩa là mint rate dự kiến giảm bao nhiêu trong 24 giờ tới.
2. **Nhịp tiêu ngân sách:**
   - `r* = (B_day − đã_tiêu_hôm_nay) / thời_gian_còn_lại × (1 + κ·u)`, với κ = 1.
   - Khi rate sắp giảm, bot được tiêu trước tối đa `2 × B_day`.
3. **Chọn tổ hợp:** với mỗi tài sản, mỗi `d` trong lưới {0,2; 0,3; 0,5; 0,75; 1; 1,5; 2; 3}%, mỗi số cặp `n`, bot chọn tổ hợp **cho nhiều PAPER/giờ nhất**: `min(r*, n·r_pair(d)) / c(d)`. Ràng buộc:
   - `c(d) ≤ max_cost_per_paper`,
   - `n · M ≤ số dư khả dụng nhỏ nhất của 2 ví − dự phòng`,
   - `n · N ≤ OI còn trống của cả hai phía`,
   - `n ≤ max_pairs`.

   Khi ngân sách là ràng buộc chính, bot tự chọn target rộng (rẻ). Chỉ khi vốn không đủ để tiêu kịp `r*` thì bot mới thu hẹp target.
4. **Dừng mở cặp mới khi:**
   - sàn hoặc market đang pause, hoặc relayer đang tạm dừng `openPosition`;
   - dữ liệu cũ, spread lớn hoặc độ lệch oracle lớn;
   - hàng đợi đang tăng nhanh và phần lời đang chờ của chính bot vượt ngưỡng;
   - chi phí thực tế trung bình 20 vòng gần nhất > `max_cost_per_paper`;
   - hết ngân sách trong ngày.

## Việc định kỳ (mỗi 5 phút)

- **Stake:** khi `paper.balance ≥ 1.000` thì stake hết (ví chính ký).
- **Claim:** khi số USDC chờ claim ≥ $5.
- **Session key:** gia hạn khi còn dưới 2 ngày.
- **Số dư:** cảnh báo khi số dư khả dụng 2 ví lệch nhau quá $100.
  - Giai đoạn đầu: các cặp mới tự co lại theo ví ít tiền hơn.
  - Sau này: tự cân bằng bằng `withdrawToCore` rồi chuyển sang địa chỉ nạp của ví kia trên HyperCore.

## Rủi ro và an toàn

- **Kill switch:** file `KILL` hoặc tín hiệu SIGTERM → ngừng mở lệnh, đóng mọi cặp.
- **Ngân sách cứng:** `B_day` mỗi ngày, cộng một mức sàn tổng: dừng hẳn khi tổng tài sản 2 ví < `equity_floor`.
- **Chặn khi dữ liệu xấu** (không mở lệnh mới):
  - mid Hyperliquid cũ hơn 5 giây, SSE mất kết nối quá 15 giây, hoặc `/state/trading` cũ;
  - spread > 3 bps hoặc mid lệch mark/oracle > 10 bps (phòng thao túng BBO).
- **Cấu hình từ server thay đổi bất thường:** kiểm tra schema bằng zod; nếu tham số impact, bust hay mức tối thiểu đổi so với lần trước thì tạm dừng và báo động.
- **Bảo vệ key:**
  - Mỗi ví chỉ giữ số vốn chạy bot.
  - Session key được sinh riêng và lưu mã hoá.
  - Server chỉ mở cổng SSH; log không bao giờ chứa key.

## Tham số mặc định

| Tham số | Mặc định đề xuất | Ghi chú |
|---|---|---|
| Vốn mỗi ví | $500 | đã chốt |
| Dự phòng mỗi ví | $50 | không đem làm margin |
| `B_day` (ngân sách đốt/ngày) | **$200** | đã chốt; quyết định tốc độ |
| `max_cost_per_paper` | **$0,0025** | đã chốt |
| `equity_floor` | $200 | dừng mở cặp mới khi tổng 2 ví xuống dưới mức này |
| `k` (bội số khoảng cách tới bust) | 2 | |
| `max_pairs` | 4 | |
| Tài sản | BTC, ETH | chọn theo OI còn trống và spread |

Ví dụ với $200/ngày và $500/ví: bot chạy khoảng 2–4 cặp ở target 0,3–0,75% (60–150x, margin khoảng $110–180 mỗi chân), chi phí khoảng $0,0016–0,0018/PAPER, tức khoảng 110–125k PAPER/ngày. Khi mint rate sắp giảm, bot được tiêu trước tối đa $400/ngày.

## Các bước triển khai

1. **Chỉ đọc (chưa cần key):** đọc trạng thái, chạy bộ điều khiển và ghi ra "sẽ làm gì". Chạy được ngay trước giờ mở sàn để kiểm tra dữ liệu.
2. **Đăng ký session key** cho 2 ví. Relayer đang cho phép.
3. **Cặp thử đầu tiên** sau giờ mở sàn: notional tối thiểu (~$5,5k), target khoảng 0,3%. Mục đích kiểm tra:
   - 2 chân có vào cùng batch không, độ trễ thực tế bao nhiêu;
   - `keep(d)` và PAPER mint thực tế có khớp mô hình không;
   - hedge trong một ví có được phép không.
4. **Bật bộ điều khiển** với các giới hạn ở trên, theo dõi sát 24 giờ đầu.
5. **Sau đó:** tự cân bằng số dư giữa 2 ví, dùng số dư hàng đợi làm margin (`useDebt`), cảnh báo qua Telegram.

## Câu hỏi còn mở

- Chốt `B_day` và `max_cost_per_paper`.
- Có cần cảnh báo qua Telegram không?
- Server: hệ điều hành và múi giờ (giờ chốt ngân sách ngày mặc định theo UTC).
