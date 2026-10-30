---
title: E2 — 媒體核心：WebRTC 與 SFU
date: 2026-10-28
status: planned
epic: E2
owner: GeneCLee6
milestones: [M0, M1, M2]
depends_on: [E11]
---

## 背景

這是整個產品的心臟：聽得到、看得到、不會斷。架構決定見 `ARCHITECTURE.md` §3：不做 P2P mesh，從 M0 就用 SFU（第一選擇 Cloudflare Realtime，後備 LiveKit），媒體層包成 `MediaTransport` 介面。訊號（誰在房、誰有哪些軌）由每房一個 Durable Object 負責，和淡江牌桌的 WebSocket 牌桌同一套手法。

E2 只管「媒體怎麼送到」；聲音好不好聽、畫面好不好看（噪音抑制、模糊、HD）在 E6；畫面排版在 E4；分享的特殊處理在 E3。

## 目標

- M0：2–8 人音訊視訊互通；裝置選擇；TURN 後備；斷線 8 秒內自動重連並恢復媒體。
- M1：simulcast 三層與接收端選層；統計與訊號格；頻寬自適應（音訊優先）；五種瀏覽器的相容矩陣有自動化測試。
- 全程：媒體層可換供應商（介面測試用假實作跑通）。

## 非目標

- 錄影（E8）、標註（E7）、遠端控制的事件通道（E9）。
- E2EE（E11 研究題）。

## 需求

### 功能

- `MediaTransport` 介面：`connect(creds)`、`publish(track, {kind, simulcast})`、`unpublish(id)`、`subscribe(remoteTrackId)`、`unsubscribe`、`setPreferredLayer(id, layer)`、`getStats()`、`on('state' | 'track' | 'stats')`、`close()`。
- RoomDO 訊號：`publish`／`unpublish` 回報 track id 與種類（mic、cam、screen、screenAudio）、`mute` 狀態；`snapshot` 給新進者全部軌；`patch` 給差異。
- 裝置：列舉麥克風、喇叭、鏡頭；切換時不中斷通話；拔掉裝置自動換下一個；權限被拒、沒有裝置、被其他程式佔用各有明確提示與重試。
- TURN：Worker 發短期憑證；ICE 一律含 TURN；統計記錄每條連線是否走 TURN。
- 重連：心跳 15 秒；WebSocket 斷掉指數退避重連（1、2、4、8 秒上限）；PeerConnection `failed` 時重建並重新發布／訂閱；回到前景、`online` 事件立即重連；期間名牌標示「重新連線中」，60 秒內保留席位。
- simulcast（M1）：cam 三層（例如 180p／360p／720p），screen 兩層；接收端依格子的像素尺寸與估計頻寬選層；RoomDO 不參與選層。
- 統計（M1）：每 2 秒 `getStats()`：RTT、丟包、位元率、幀率、解析度、是否 TURN；訊號格三段（好／普通／差）；統計面板給自己看。
- 頻寬自適應（M1）：估計下行不足時先降別人的視訊層、再停收非講話者視訊、最後才提示「網路不佳，已切純音訊」；上行不足時降自己的最高層。

### 非功能

- 同區域端到端音訊延遲 < 300 ms；進房到第一幀 < 3 秒（寬頻）。
- 每個 RoomDO 訊息處理 < 10 ms CPU。
- 媒體層所有程式碼在 `src/media/`，不 import React。

## 設計方向

- `src/media/MediaTransport.ts`（介面與型別）、`CloudflareRealtimeTransport.ts`（第一實作）、`FakeTransport.ts`（測試）、M1 選用 `LiveKitTransport.ts`。
- Worker 代理 Realtime 的 session／tracks API，App token 不進瀏覽器；瀏覽器只拿自己 session 的短期資訊。
- `useRoomMedia()` hook 把 RoomDO 的軌清單與 transport 的訂閱對齊（desired vs actual，diff 後補訂閱／退訂）。
- 整合測試：Playwright 開兩個 Chromium 用假攝影機（`--use-fake-device-for-media-stream`）互相聽到對方的音量 > 0、看到對方的幀；CI 每次跑。

## 驗收條件

- [ ] AC-2.1 — 每房一個 RoomDO：成員與軌清單、心跳、差異推送；新進者收到完整快照；訊息型別在 `shared/protocol.ts` 且有測試。
- [ ] AC-2.2 — 透過 `MediaTransport`（Cloudflare Realtime 實作）發布與訂閱音訊視訊；8 人同時在線互通；介面的假實作能跑完整個 `useRoomMedia` 測試。
- [ ] AC-2.3 — 麥克風、鏡頭開關即時同步到所有人；可切換麥克風、喇叭、鏡頭不中斷通話；拔裝置自動換；權限被拒、無裝置、被佔用有明確提示與重試。
- [ ] AC-2.4 — ICE 含 TURN 短期憑證；關掉 UDP 直連（模擬嚴格 NAT）仍能通話；統計記錄是否走 TURN。
- [ ] AC-2.5 — 斷網 30 秒再恢復，8 秒內自動接回同一席位並恢復收發；回到前景立即重連；期間名牌標示「重新連線中」。
- [ ] AC-2.6 — cam 三層 simulcast、screen 兩層；接收端依格子大小與頻寬選層；8 人格狀時每人下行 ≤ 4 Mbps。
- [ ] AC-2.7 — 名牌訊號格（三段）與自己的統計面板（RTT、丟包、位元率、幀率、解析度、TURN）；頻寬不足時依「先降視訊、再停收、最後純音訊」的順序自動處理並提示。
- [ ] AC-2.8 — Chrome、Edge、Firefox、Safari（macOS）、iOS Safari、Android Chrome 的相容矩陣有 Playwright／實機清單；每個功能的支援度寫進 `docs/BROWSER-SUPPORT.md`。

## Task 拆分

### M0

- [x] `e2-t01` ADR `docs/adr-001-media-layer.md`：Cloudflare Realtime vs LiveKit vs 自架，決定與切換條件；`MediaTransport` 介面定稿（＋`FakeTransport`、Worker 代理 `/api/sfu/*`、`/dev/realtime` 兩瀏覽器 spike；兩台裝置實測待 secret 設定後補） · AC-2.2 · #4
- [x] `e2-t02` RoomDO 訊號骨架：WebSocket 升級、成員表、心跳、`snapshot`／`patch` 差異推送、`shared/protocol.ts` · AC-2.1 · #3
- [ ] `e2-t03` `CloudflareRealtimeTransport`：Worker 代理 session 建立、`publish` mic／cam、track id 回報 RoomDO · AC-2.2 · M · ← e2-t01, e2-t02
- [ ] `e2-t04` 訂閱：依 RoomDO 軌清單 pull 別人的軌、renegotiation、`useRoomMedia` 的 desired／actual 對齊 · AC-2.2 · M · ← e2-t03
- [ ] `e2-t05` 麥克風／鏡頭開關與軌狀態同步（mute 走訊號，不重新 publish） · AC-2.3 · S · ← e2-t04
- [ ] `e2-t06` 裝置列舉與切換（麥克風、喇叭 `setSinkId`、鏡頭）、拔裝置自動換、記住選擇 · AC-2.3 · M · ← e2-t05
- [ ] `e2-t07` TURN：Worker 發短期憑證 API、ICE 設定、統計是否走 TURN · AC-2.4 · S · ← e2-t03
- [ ] `e2-t08` 斷線重連：WebSocket 指數退避、PeerConnection 重建、媒體恢復、前景／online 事件、「重新連線中」狀態 · AC-2.5 · M · ← e2-t04
- [ ] `e2-t09` 權限與裝置錯誤處理：被拒、無裝置、被佔用、不支援的瀏覽器，各有畫面與重試 · AC-2.3 · S · ← e2-t06
- [ ] `e2-t10` 整合測試：Playwright 兩個 Chromium 假裝置互通（音量 > 0、有幀）、`FakeTransport` 跑 `useRoomMedia` 單元測試、進 CI · AC-2.2 · M · ← e2-t08

### M1

- [ ] `e2-t11` simulcast 發布：cam 三層、screen 兩層、編碼參數 · AC-2.6 · M · ← e2-t10
- [ ] `e2-t12` 接收端選層：依格子像素尺寸與頻寬估計 `setPreferredLayer`，版面變動時重算 · AC-2.6 · M · ← e2-t11, e4-t04
- [ ] `e2-t13` `getStats()` 收集與名牌訊號格 · AC-2.7 · S · ← e2-t10
- [ ] `e2-t14` 統計面板（自己的連線、每條訂閱）、匯出 JSON 給除錯 · AC-2.7 · S · ← e2-t13
- [ ] `e2-t15` 頻寬自適應策略：下行降層→停收非講話者→純音訊提示；上行降最高層 · AC-2.7 · M · ← e2-t12, e2-t13
- [ ] `e2-t16` 相容矩陣：Playwright 多瀏覽器、iOS／Android 實機檢查清單、`BROWSER-SUPPORT.md` 完整版 · AC-2.8 · M · ← e2-t10, e11-t04
- [ ] `e2-t17` `LiveKitTransport` 後備實作（選用，當 Realtime 條件變動時啟動） · AC-2.2 · M · ← e2-t10

### M2

- [ ] `e2-t18` 只訂閱可見者與講話者（與 E10 `e10-t01` 一起）、非可見者退訂 · M

## 風險與對策

| 風險 | 對策 |
| --- | --- |
| Cloudflare Realtime API 細節與文件不足 | `e2-t01` 先做 spike：兩個瀏覽器互通的最小範例，再寫 ADR |
| Safari 的 simulcast／編碼差異 | M1 `e2-t16` 矩陣；Safari 退化為單層 |
| 重連後軌 id 變動造成重複訂閱 | desired／actual 對齊是唯一的訂閱入口；測試覆蓋重連 |
| 免費流量超額 | E11 成本儀表板；接收端選層本身就是省流量 |

## 未決問題

- [x] **Q:** Realtime 的錄製能力是否足夠（影響 E8 雲端錄影）？
      **A:** 不夠：SFU 沒有內建錄影；WebSocket adapter 只能送 PCM 音訊與 JPEG 幀，適合逐字稿、不適合錄視訊。雲端錄影在 `e8-t04` 比較自架合成與 RealtimeKit 錄影（`adr-001-media-layer.md`）。
- [ ] **Q:** 音訊要不要走 SFU 的音訊層選擇（例如只轉送最大聲的 3 路）？
      **A:** _(M2 再看，8 人以內不需要)_
