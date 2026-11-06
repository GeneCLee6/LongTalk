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

- [x] AC-2.1 — 每房一個 RoomDO：成員與軌清單、心跳、差異推送；新進者收到完整快照；訊息型別在 `shared/protocol.ts` 且有測試。
- [ ] AC-2.2 — 透過 `MediaTransport`（Cloudflare Realtime 實作）發布與訂閱音訊視訊；8 人同時在線互通；介面的假實作能跑完整個 `useRoomMedia` 測試。
- [ ] AC-2.3 — 麥克風、鏡頭開關即時同步到所有人；可切換麥克風、喇叭、鏡頭不中斷通話；拔裝置自動換；權限被拒、無裝置、被佔用有明確提示與重試。
- [ ] AC-2.4 — ICE 含 TURN 短期憑證；關掉 UDP 直連（模擬嚴格 NAT）仍能通話；統計記錄是否走 TURN。
- [ ] AC-2.5 — 斷網 30 秒再恢復，8 秒內自動接回同一席位並恢復收發；回到前景立即重連；期間名牌標示「重新連線中」。
- [ ] AC-2.6 — cam 三層 simulcast、screen 兩層；接收端依格子大小與頻寬選層；8 人格狀時每人下行 ≤ 4 Mbps。
- [ ] AC-2.7 — 名牌訊號格（三段）與自己的統計面板（RTT、丟包、位元率、幀率、解析度、TURN）；頻寬不足時依「先降視訊、再停收、最後純音訊」的順序自動處理並提示。
- [ ] AC-2.8 — Chrome、Edge、Firefox、Safari（macOS）、iOS Safari、Android Chrome 的相容矩陣有 Playwright／實機清單；每個功能的支援度寫進 `docs/BROWSER-SUPPORT.md`。（H6 #35：矩陣、Playwright 三引擎與實機清單都有了；**還沒勾**：六欄裡 Edge、Firefox、Safari、iOS Safari 都還沒有實機紀錄，Android Chrome 只有加入與互看。擁有者照 `DEPLOY.md` §5「實機測試計畫」每欄至少跑完短版 1–3 步、在 BROWSER-SUPPORT 記成 ● 後才勾。）

## Task 拆分

### M0

- [x] `e2-t01` ADR `docs/adr-001-media-layer.md`：Cloudflare Realtime vs LiveKit vs 自架，決定與切換條件；`MediaTransport` 介面定稿（＋`FakeTransport`、Worker 代理 `/api/sfu/*`、`/dev/realtime` 兩瀏覽器 spike；兩台裝置實測待 secret 設定後補） · AC-2.2 · #4
- [x] `e2-t02` RoomDO 訊號骨架：WebSocket 升級、成員表、心跳、`snapshot`／`patch` 差異推送、`shared/protocol.ts` · AC-2.1 · #3
- [x] `e2-t03` `CloudflareRealtimeTransport`：Worker 代理 session 建立、`publish` mic／cam、track id 回報 RoomDO（`/api/sfu/<roomId>/*` 只服務帶成員 session token 的呼叫，session 屬於該成員、只能 pull 同房的軌；協定 v3 `tracks`、`Member.tracks`；`/dev/realtime` spike 移除） · AC-2.2 · #8
- [x] `e2-t04` 訂閱：依 RoomDO 軌清單 pull 別人的軌、renegotiation、`useRoomMedia` 的 desired／actual 對齊（`src/room/RoomMedia.ts`；會議室簡版格狀畫面，正式版面是 C1） · AC-2.2 · #8
- [x] `e2-t05` 麥克風／鏡頭開關與軌狀態同步（mute 走訊號，不重新 publish）（協定 v4 `MemberTrack.muted`；`MediaTransport.replaceTrack`，關掉＝送 null，不重新協商；鏡頭關掉時停止裝置；本月只剩音訊時關掉的鏡頭不能再開） · AC-2.3 · #9
- [x] `e2-t06` 裝置列舉與切換（麥克風、喇叭 `setSinkId`、鏡頭）、拔裝置自動換、記住選擇（`src/room/LocalDevices.ts`；選擇存 localStorage，和預先加入頁共用；接上新裝置時自動補回） · AC-2.3 · #9
- [x] `e2-t07` TURN：Worker 發短期憑證 API、ICE 設定、統計是否走 TURN（`POST /api/turn/<roomId>` 只發給帶成員 session token 的呼叫，TTL 3 小時、到 2/3 時以 `setConfiguration` 換新、濾掉 port 53；沒設 TURN secret 或 Cloudflare 失敗時只給 STUN 照常運作；協定 v5 `stats.relay`，自己的名牌標「經由轉送伺服器」；免費額度保護對走 TURN 的接收端 ×1.1；`?ice=relay` 強制走 TURN 的除錯旗標） · AC-2.4 · #10
- [x] `e2-t08` 斷線重連：WebSocket 指數退避、PeerConnection 重建、媒體恢復、前景／online 事件、「重新連線中」狀態（`RoomConnection` 1、2、4、8 秒＋抖動、同一 token 回同一成員，60 秒後放棄並給「重試」；心跳沒回、`offline`、回前景探測不回就換 socket；`RoomMedia` 在 ICE `failed` 或 `disconnected` 超過 4 秒時重建 session：新的 ICE 伺服器、重新發布與訂閱，同樣退避與上限；`src/room/backoff.ts`、`network.ts`） · AC-2.5 · #10
- [x] `e2-t09` 權限與裝置錯誤處理：被拒、無裝置、被佔用、不支援的瀏覽器，各有畫面與重試（會議室內的提示＋「重試」；裝置中斷且沒有別的＝`lost`；沒有 WebRTC 的瀏覽器在進房前就看到說明） · AC-2.3 · #9
- [x] `e2-t10` 整合測試：Playwright 兩個 Chromium 假裝置互通（音量 > 0、有幀）、`FakeTransport` 跑 `useRoomMedia` 單元測試、進 CI（`e2e/interop.spec.ts`、`npm run test:e2e`＋`BASE_URL`；`preview.yml` 的 `e2e` job 在 smoke test 之後對 PR 預覽跑，經真的 Realtime SFU；雙向有幀、音量 > 0、靜音與關鏡頭對方看得到、打開後恢復；沒有預覽或預覽沒有 SFU secret 時略過並留 notice；`tests/app/useRoomMedia.test.tsx` 兩個成員共用 `FakeSfu` 與 RoomDO 替身；測試抓到並修好：pull 同時要求重新協商又回軌錯誤時先回答再檢查，`session_error` 讓 transport `failed` 觸發重建） · AC-2.2 · #11

### M1

- [x] `e2-t11` simulcast 發布：cam 三層、screen 兩層、編碼參數（VP8；鏡頭改要 1280×720，Chrome 從 640×480 只送兩層；cam `f` 720p 1.2 Mbps／`h` 360p 400 kbps／`q` 180p 120 kbps 15 fps，screen `f` 原尺寸 2.5 Mbps／`h` 一半 600 kbps 15 fps；`src/media/encoding.ts` `SIMULCAST`；瀏覽器拒絕 simulcast 時送一層；起始頻寬與只送 VP8 照舊，三人以上 payload type 問題沒有回來） · AC-2.6 · #29
- [x] `e2-t12` 接收端選層：依格子像素尺寸與頻寬估計 `setPreferredLayer`，版面變動時重算（`src/media/layers.ts` 純函式：格子畫出的像素（×devicePixelRatio，最多 2 倍）、看不見（翻頁、捲出條帶、只顯示首字、分頁在背景）就最低層、每人視訊下行預算 3.4 Mbps（小格先讓）、遲滯；`useVideoDemand` 用 ResizeObserver／IntersectionObserver 回報，`RoomMedia` 400 ms 去抖動後只送有變的層；拉軌時就帶起始層（鏡頭 medium、分享 high）；Realtime 照要的層送（`priorityOrdering: none`：讓 SFU 自己估計時，格狀的格子被換到 720p、釘選的大格 35 秒都到不了 720p），沒有那層才往下找（`ridNotAvailable: asciibetical`）；瀏覽器的 `availableIncomingBitrate` 跟著已收到的量走、當上限會把層鎖在最低，所以不用，依丟包與凍結降層是 H2 的 `e2-t15`；Realtime 沒有暫停訂閱的 API，看不見就最低層） · AC-2.6 · #29
- [x] `e2-t13` `getStats()` 收集與名牌訊號格（`RoomMedia` 每 2 秒一次 `MediaTransport.getStats()`，`src/media/stats.ts` 依 mid 讀出每條送出與收到的軌、兩次讀數算出位元率／丟包／卡頓／jitter buffer；H3 的 HD 上行檢查也讀同一份；`src/media/quality.ts` 判好／普通／差，三次裡兩次差才算差；自己的名牌用自己的，別人的經協定 v14 `signal`（變了才送、最多每 5 秒，RoomDO 每人每 10 秒最多 3 次）放在 `Member.signal`；訊號格 `SignalBars` 三格＋文字名稱） · AC-2.7 · #31
- [x] `e2-t14` 統計面板（自己的連線、每條訂閱）、匯出 JSON 給除錯（「更多 › 連線統計」：電腦右側面板、手機全螢幕抽屜，lazy chunk；往返延遲、收送位元率與丟包、直連或 TURN、候選類型與協定、上行估計、自動調整的狀態；送出的每層解析度／幀率／位元率／是否關閉／編碼受限原因；每條訂閱的成員、種類、要求的層、解析度、幀率、位元率、丟包、抖動、卡頓；「匯出 JSON」含名字、不含 token／密碼／SDP） · AC-2.7 · #31
- [x] `e2-t15` 頻寬自適應策略：下行降層→停收非講話者→純音訊提示；上行降最高層（`src/media/adaptation.ts` 兩個純狀態機，每 2 秒一步：下行連續 2 次「差」就把視訊預算降到要求量的 60%（不低於全部最低層），都最低了還差就退訂釘選／聚光燈／講話者以外的鏡頭（最多留 2 個，講話者換人時保留 15 秒，避免每幾秒退訂又訂閱），再差就出提示條建議 H3 的純音訊模式；連續 5 次「好」往上一段，剛升就又差時等待加倍（最多 60 秒）；「差」一定要有丟包，沒有丟包的隱藏音、jitter buffer、卡頓最多算「普通」（CI 上 CPU 不夠時會這樣）。上行：編碼器因頻寬受限或 SFU 回報丟包 ≥ 10% 連續 10 秒，用 H3 的 `setTopLayer` 關鏡頭的 `f`，再來分享的 `f`、鏡頭的 `h`；CPU 受限只關鏡頭的 `f`；30 秒都正常（有上行估計時要夠）才一層層開回；聲音從不動；toast「網路不穩，已降低畫質」等） · AC-2.7 · #31
- [x] `e2-t16` 相容矩陣：Playwright 多瀏覽器、iOS／Android 實機檢查清單、`BROWSER-SUPPORT.md` 完整版（`e2e/local/browsers.spec.ts` 在 Chromium、Firefox、WebKit 跑 app 自己的 `capabilities.ts` 並和 BROWSER-SUPPORT 的三欄比對、首頁、預先加入（假裝置／拒絕／沒有裝置）、兩人聊天與參與者、手機大小，CI `UI checks / browsers`；`e2e/crossbrowser.spec.ts` 讓 Firefox、WebKit 各和 Chromium 經真的 SFU 互看互聽、靜音、互相看分享並記下 simulcast 層，CI `Preview / e2e-firefox`；`DEPLOY.md` §5「實機測試計畫」短版（一台電腦＋一支手機，15–30 分鐘）與依裝置的完整版；BROWSER-SUPPORT 完整版（● 實機、● CI、○、✕、?）；修了 Firefox 聊天送出鈕被擠出面板） · AC-2.8 · #35
- [ ] `e2-t17` `LiveKitTransport` 後備實作（選用，當 Realtime 條件變動時啟動） · AC-2.2 · M · ← e2-t10

### M2

- [x] `e2-t18` 只訂閱可見者與講話者（與 E10 `e10-t01` 一起）、非可見者退訂（L1，#49：`src/media/subscriptions.ts`、`TileSeat`、`RoomMedia` 的 `visibleOnly`） · M

## 風險與對策

| 風險 | 對策 |
| --- | --- |
| Cloudflare Realtime API 細節與文件不足 | `e2-t01` 先做 spike：兩個瀏覽器互通的最小範例，再寫 ADR |
| Safari 的 simulcast／編碼差異 | M1 `e2-t16` 矩陣；Safari 退化為單層（H6：Playwright 的 WebKit 協商三層、剛加入時只有最高層有畫面，Chromium 照樣看得到；真的 Safari 等實機） |
| 重連後軌 id 變動造成重複訂閱 | desired／actual 對齊是唯一的訂閱入口；測試覆蓋重連 |
| 免費流量超額 | E11 成本儀表板；接收端選層本身就是省流量 |

## 未決問題

- [x] **Q:** Realtime 的錄製能力是否足夠（影響 E8 雲端錄影）？
      **A:** 不夠：SFU 沒有內建錄影；WebSocket adapter 只能送 PCM 音訊與 JPEG 幀，適合逐字稿、不適合錄視訊。雲端錄影在 `e8-t04` 比較自架合成與 RealtimeKit 錄影（`adr-001-media-layer.md`）。
- [ ] **Q:** 音訊要不要走 SFU 的音訊層選擇（例如只轉送最大聲的 3 路）？
      **A:** _(M2 再看，8 人以內不需要)_
