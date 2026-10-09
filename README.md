# papertrade

Bot farm $PAPER trên [Papertrade](https://papertrade.xyz) bằng các cặp long/short hedge nhau trên 2 ví. Bot tự điều chỉnh tốc độ theo mint rate và tốc độ tăng LP.

Trạng thái: **đang thiết kế, chưa có code.**

## Tài liệu

- [`docs/protocol.md`](docs/protocol.md): cơ chế Papertrade (haircut, liquidation, hàng đợi, đường mint, staking), tham số on-chain, địa chỉ contract, kinh tế của cặp long/short.
- [`docs/relayer-api.md`](docs/relayer-api.md): API relayer và định dạng intent EIP-712 (chưa có doc chính thức, đọc từ frontend).
- [`docs/design.md`](docs/design.md): thiết kế bot (bản nháp chờ duyệt).
- Doc gốc: [docs.papertrade.xyz](https://docs.papertrade.xyz), [docs.paperstrategy.xyz](https://docs.paperstrategy.xyz).
