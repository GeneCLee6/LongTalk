# NEXT — 接下來怎麼做（給 AI 協作者與自己的交接手冊）

最後更新 2026-10-28。**完整順序在 [`ROADMAP.md`](ROADMAP.md)**（一批一個 PR）；這份只記「現在的位置」與工作方式。每完成一批就更新「現在的位置」；每個 AI session 開頭只需要讀 `CLAUDE.md` 和這一份。

## 1. 現在的位置

- **2026-10-28 規劃完成，尚未有程式碼。** 總 PRD `docs/PRD/00-prd.md`、競品分析 `01-competitive-analysis.md`、11 個 epic（130 個 task、74 條 AC）、`ROADMAP.md` Phase A–O（跳過 E、M）、架構 `ARCHITECTURE.md`、設計規格 `DESIGN.md`、視覺稿 `design/mockup.html`、提案頁 `design/pitch.html`、標誌 `design/logo/`。規劃方法的判斷在 `PLANNING-METHOD.md`。
- **下一批：A1**（repo 骨架、CI、部署）。接著 **A2 是最關鍵的一批**：Cloudflare Realtime 的 spike 決定媒體層；不順就在 ADR 換 LiveKit，之後批次不變。
- **等人決定的事**（不卡 A 期）：產品名稱是否定為「長談 · LongTalk」（備選在 `00-prd.md` §14）；帳號登入方式（E1）；AI 摘要用哪家模型（E8）。

## 2. 建議順序（為什麼這樣排）

| # | 做什麼 | Phase | 為什麼排這裡 |
| --- | --- | --- | --- |
| 1 | repo、CI、部署 | A1 | 之後每批都要能 PR 預覽與自動部署 |
| 2 | 媒體層 ADR 與 spike | A2 | 最大的外部風險；先證明兩個瀏覽器能透過 SFU 互通，再寫其他東西 |
| 3 | 訊號 DO 與房間 | A3–A4 | 媒體要掛在房間上；沿用牌桌的 WebSocket 差異推送手法 |
| 4 | 發布、訂閱、裝置、TURN、重連 | B | 「不會斷」的核心；B3 重連做完才算 |
| 5 | 版面、工具列、手機 | C | 有媒體才有東西可排；手機在 M0 就要能加入 |
| 6 | 分享、聊天、遙測、品牌 | D | 分享依賴版面；遙測要在第一次給朋友用之前就有 |
| 7 | 主持人控制 → 介面完整 → 品質 → 帳號與錄影 | F–I | 先讓主持人能控場，再補 Zoom 使用者習慣的細節，最後才做需要帳號的功能 |
| 8 | 標註、雲端錄影與 AI、規模 | J–L | 三條線互不依賴，都要 M1 穩定 |
| 9 | 遠端控制 | N | 風險最高、依賴桌面端代理，最後做 |

## 3. 工作方式（每批）

1. **在 worktree 開分支**：`git worktree add ../_wt/<分支> -b feat/<第一個 task 編號>-<slug>`。
2. **只讀需要的段落**：`CLAUDE.md`、這份、`ROADMAP.md` 的該批、該批 task 所在的 epic 段落、相關的 `ARCHITECTURE.md` 章節。不要整本讀。
3. **做完跑** `npm run lint && npm run typecheck && npm test && npm run build`，只看最後 5 行。
4. **一批一個 ready PR**：標題英文、結尾列出全部 task 編號；本文（繁中）寫對應 AC、怎麼驗證、兩台裝置實測結果（媒體相關）。
5. **在同一個 PR 更新文件**：epic 勾選 task（寫 PR 號）、AC 勾選（有驗證才勾）、`PRD/README.md` 進度表、`ROADMAP.md` 該批 `[x]` 與 PR 號、這份「現在的位置」。
6. **CI 綠了直接合併**（`gh pr merge --squash --delete-branch`），需要人決定的事才停下來問。
7. 合併後回報：做了什麼、PR 號、下一批是哪一批、有沒有等人決定的事。

## 4. 不要做的事

- 不要在 M0 做 P2P mesh「先擋著」：會重寫。
- 不要在 RoomDO 以外判斷權限；不要在前端判斷誰能靜音誰。
- 不要把 SFU App token、R2 憑證、AI 金鑰放進前端。
- 不要為 M2／M3 的 task 提前細拆或實作；動工那批再拆。
- 不要改名、換色、換標誌，除非使用者拍板（`00-prd.md` §14）。
