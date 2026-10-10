# papertrade

Bot farm $PAPER trên [Papertrade](https://papertrade.xyz) bằng các cặp long/short hedge nhau trên 2 ví. Bot tự chọn tài sản, target, leverage và số cặp theo mint rate, tốc độ tăng LP, độ dao động và ngân sách.

> Phần mềm thử nghiệm trên một protocol mới, contract upgradeable và API chưa có doc chính thức. Chỉ nạp số tiền bạn chấp nhận mất.

## Tài liệu

- [`docs/protocol.md`](docs/protocol.md): cơ chế Papertrade, tham số on-chain, địa chỉ contract, kinh tế của cặp long/short.
- [`docs/relayer-api.md`](docs/relayer-api.md): API relayer và định dạng intent EIP-712.
- [`docs/design.md`](docs/design.md): thiết kế bot.
- Doc gốc: [docs.papertrade.xyz](https://docs.papertrade.xyz), [docs.paperstrategy.xyz](https://docs.paperstrategy.xyz).

## Cài đặt (server Linux, Node 22 LTS)

```bash
git clone <repo> /opt/papertrade && cd /opt/papertrade
npm ci
npm run build
npm test                      # 39 unit test, không cần mạng

cp .env.example .env && chmod 600 .env        # điền PT_WALLET_A_KEY, PT_WALLET_B_KEY
cp config.example.json config.json            # tham số, xem bên dưới
```

Hai ví phải là **ví mới chỉ dùng cho bot**. Mỗi ví nạp **$500 USDC** qua app (nút Deposit trên `exchange.papertrade.xyz`). Bot không tự nạp tiền.

## Các bước chạy

```bash
set -a; . ./.env; set +a      # nạp biến môi trường cho các lệnh CLI

node dist/cli.js status       # trạng thái protocol, số dư, PAPER, vị thế, session key của 2 ví
node dist/cli.js plan         # bộ điều khiển muốn làm gì lúc này (bảng ứng viên)
node dist/cli.js monitor      # chạy liên tục ở chế độ chỉ đọc, ghi log quyết định mỗi 30 giây
node dist/cli.js register     # tạo + đăng ký session key cho 2 ví (ví chính ký một lần)
```

Khi `status` báo cả 2 ví đã có tiền và session key ở trạng thái "registered", và relayer không còn tạm dừng `openPosition`/`closePositions`:

1. Đặt `"mode": "live"` trong `config.json`.
2. Chạy `node dist/cli.js run`, hoặc dùng systemd: [`deploy/ptbot.service`](deploy/ptbot.service).
3. Theo dõi `journalctl -u ptbot -f`. Mỗi cặp đã đóng được ghi một dòng vào `data/cycles.jsonl`.

**Dừng khẩn cấp:** `node dist/cli.js kill` tạo file `KILL`. Bot đang chạy sẽ đóng mọi cặp rồi tự thoát. Xoá file `KILL` trước khi chạy lại.

**Dừng bình thường** (`systemctl stop`, Ctrl-C): các cặp đang mở được giữ nguyên vì đã hedge. Lần chạy sau bot đọc lại từ `data/pairs.json` và tiếp tục quản lý.

Các lệnh khác: `stake`, `claim` (bot cũng tự làm mỗi 5 phút).

## Tham số chính (`config.json`)

| Khoá | Mặc định | Ý nghĩa |
|---|---|---|
| `mode` | `monitor` | `live` mới được ký và gửi lệnh |
| `budget.dailyUsd` | 200 | Lỗ ròng tối đa mỗi ngày UTC (tức "tốc độ") |
| `budget.maxCostPerPaper` | 0.0025 | Không mở cặp có chi phí mô hình vượt mức này |
| `budget.equityFloorUsd` | 200 | Dừng mở cặp mới khi tổng tài sản 2 ví xuống dưới mức này |
| `budget.reservePerWalletUsd` | 50 | Phần giữ lại trong mỗi ví, không dùng làm margin |
| `budget.circuitBreakerMultiple` | 1.3 | Tạm dừng khi chi phí thực tế 20 cặp gần nhất > 1,3 × trần |
| `pairs.maxPairs` | 4 | Số cặp mở cùng lúc tối đa |
| `pairs.bustSafetyMultiple` | 2 | Mức bust phải cách giá vào ≥ 2 × target |
| `pairs.emergencyBustFraction` | 0.7 | Đóng khẩn cấp khi một chân đã dùng 70% khoảng cách tới bust |
| `pairs.singleWalletHedge` | false | Đặt cả 2 chân trong cùng một ví (chỉ bật khi đã thử thấy sàn cho phép) |
| `risk.maxSpreadBps` | 3 | Không mở khi spread Hyperliquid lớn hơn mức này |
| `risk.pauseOnQueue` | false | Tạm dừng khi có hàng đợi trả thưởng (mặc định: chỉ tính chi phí cao hơn) |
| `exchangeBuildId` | tự đọc | Header `X-Papertrade-Build`; đặt tay nếu tự đọc thất bại |

Với vốn $500/ví và $200/ngày, bộ điều khiển thường chọn target 0,3–0,75% (leverage 60–150x), mỗi chân margin khoảng $110–180. Chi phí khoảng $0,0016–0,0018/PAPER, tức khoảng 110–125k PAPER/ngày nếu tiêu hết ngân sách. Lưu ý: tiêu $200/ngày thì vốn $1.000 chỉ đủ khoảng 4 ngày.

## Bot làm gì

- **Mỗi 30 giây:** đọc mint rate, tốc độ tăng LP, hàng đợi, OI cap, độ dao động và độ trễ, rồi chọn có mở thêm cặp hay không (tối đa 1 cặp mỗi lượt).
- **Mỗi giây:** theo dõi từng cặp, đóng cả 2 chân khi giá chạy đủ target, khi chạm 70% khoảng cách tới bust, hoặc khi giữ quá lâu.
- **Xử lý sự cố:**
  - Một chân không khớp: huỷ hoặc đóng chân còn lại.
  - Một chân bị liquidate: đóng chân kia ngay.
  - Vị thế lạ trong ví (không thuộc cặp nào): tự đóng sau 2 phút.
- **Mỗi 5 phút:** stake PAPER (khi ≥ 1.000), claim USDC (khi ≥ $5), gia hạn session key trước khi hết hạn 2 ngày.
