# NEXT — 接下來怎麼做（給 AI 協作者與自己的交接手冊）

最後更新 2026-10-30。**完整順序在 [`ROADMAP.md`](ROADMAP.md)**（一批一個 PR）；這份只記「現在的位置」與工作方式。每完成一批就更新「現在的位置」；每個 AI session 開頭只需要讀 `CLAUDE.md` 和這一份。

## 1. 現在的位置

- **2026-10-28 規劃完成，尚未有程式碼。** 總 PRD `docs/PRD/00-prd.md`、競品分析 `01-competitive-analysis.md`、11 個 epic（130 個 task、74 條 AC）、`ROADMAP.md` Phase A–O（跳過 E、M）、架構 `ARCHITECTURE.md`、設計規格 `DESIGN.md`、視覺稿 `design/mockup.html`、提案頁 `design/pitch.html`、標誌 `design/logo/`。規劃方法的判斷在 `PLANNING-METHOD.md`。
- **2026-10-30 A1 完成**（#2）：Vite＋React＋TS 骨架、一個 Worker（`/api/health`、`RoomDO` 空殼、靜態資產）、Vitest、oxlint、JS 預算腳本、CI、PR 預覽與正式部署 workflow、`RULES.md`、`DEPLOY.md`。2026-10-31 secret 設好，正式站 https://longtalk.genelee-pro.workers.dev 上線，AC-11.1 已勾（#6）。
- **2026-10-30 A2 完成**（#4）：`docs/adr-001-media-layer.md`（採用 Cloudflare Realtime SFU，LiveKit 後備與切換條件）、`MediaTransport` 介面定稿＋`FakeTransport`、Worker 代理 `/api/sfu/*`（`worker/sfu.ts`）、`CloudflareRealtimeTransport` 草稿、`/dev/realtime` 兩瀏覽器 spike；設計 token（深淺色 CSS 變數）、`GlobalStyle`、Button／IconButton／Menu／Toast、`strings.ts` 骨架。**兩台裝置實測尚未做**：要先建立 Realtime SFU app 並設定 `REALTIME_APP_ID`、`REALTIME_APP_SECRET`（`DEPLOY.md` §5），實測通過前 AC-2.2 不勾；不通就照 ADR 的切換條件改 LiveKit。
- **2026-10-30 A3 完成**（#3）：`shared/protocol.ts`（v1：`welcome`／`snapshot`／`patch`／`error`、`resync`、文字 `ping`／`pong` 心跳）、`shared/patch.ts` 差異推送、`shared/room-id.ts`（10 碼 base58）、`RoomDO`（hibernation WebSocket、成員、45 秒沒心跳就移除、`worker/room-host.ts` 純類別）、`POST /api/rooms` 與 WebSocket `/api/rooms/<id>/ws?v=1`、首頁「建立會議室」、會議室頁顯示在線人數。AC-2.1 等 `e2-t03` 加上軌清單才勾；AC-1.1 等 `e1-t05`（改名、複製連結）。
- **2026-10-30 A4 完成**（#5），**Phase A 全部完成**：通訊協定升到 v2（`join`／`leave`、`welcome.token`、`Member.name`／`reconnecting`；v1 瀏覽器在升級時收到 4400 要求重新整理）；RoomDO 發 session token，斷線（沒有 `leave`）保留成員 60 秒並標示「重新連線中」，同一 token 回來就是同一成員，同一 token 從新 socket 加入會關掉舊的（4410）；成員與 session 存在 DO storage，DO 被逐出也接得回；開了 10 秒不 `join` 的 socket 會被關掉；WebSocket 升級檢查 `Origin`（不同站 403）；`GET /api/rooms/<id>` 給預先加入頁人數。首頁照 DESIGN §4.1（標誌、一句話、開一間房、貼連結或代碼加入、三張小卡）。預先加入簡版：鏡像預覽、音量表、麥克風／鏡頭／喇叭選單（喇叭只在支援 `setSinkId` 的瀏覽器出現）、麥克風與鏡頭開關、權限被拒與找不到裝置的說明＋重試；裝置存取在 `src/media/devices.ts`、`levelMeter.ts`，hook 在 `src/room/`。名字存 localStorage；token 存 sessionStorage（同分頁重新整理直接回房，不再經過預先加入；第二個分頁是新成員）。**兩台裝置實測尚未做**：AC-1.2（還差 `e1-t05` 房內改名）、AC-4.1（還差 `e4-t19` 品牌定稿）、AC-4.2（還差 `e4-t09`，且鏡頭預覽、音量表、裝置選單要在兩台不同裝置實測）都還不勾。
- **下一批：B1**（`e2-t03` `e2-t04`：發布 mic／cam、訂閱；依賴 A4）。開工前要先做 A2 的兩台裝置實測（建立 Realtime SFU app、設定 secret）；預先加入的鏡頭、麥克風、裝置選單也一起在兩台裝置上試。
- **等人決定的事**（不卡 A 期）：帳號登入方式（E1）；AI 摘要用哪家模型（E8）；建立 Cloudflare Realtime SFU app 並設定 secret，做 A2 的兩台裝置實測（B1 之前）。

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
