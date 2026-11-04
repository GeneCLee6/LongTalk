# ARCHITECTURE — LongTalk 技術架構（規劃版）

2026-10-28 的規劃；A1（2026-10-30）起骨架已落地（一個 Worker：`/api/*`、`RoomDO`、靜態資產）。動工後這份逐步改成現況描述，決策的「為什麼」搬到 `docs/adr-*.md`。

## 1. 一句話

**瀏覽器 WebRTC 客戶端 ＋ Cloudflare 全套後端：Workers（API ＋ 前端靜態資產，同一個 Worker；為什麼不用 Pages 見 `DEPLOY.md`）、Durable Objects（每房一個訊號伺服器）、Realtime SFU（媒體轉送）、TURN（NAT 後備）、R2（檔案與錄影）。** 伺服器不碰媒體內容，只負責「誰在哪、誰能做什麼」與轉送封包。

## 2. 元件圖

```
瀏覽器 A ──WebSocket──┐                  ┌──WebSocket── 瀏覽器 B
   │                  ▼                  ▼                  │
   │        Worker (/api/*) ── RoomDO（每房一個）            │
   │          建房、TURN 憑證、   成員、角色、軌道狀態、        │
   │          上傳簽章、帳號      聊天、標註、等候室、alarm      │
   │                  │                                      │
   │                  └── R2（檔案、錄影、白板）                │
   │                                                         │
   └──WebRTC（DTLS-SRTP）──▶ Cloudflare Realtime SFU ◀──WebRTC──┘
                     （直連失敗時經 Cloudflare TURN）
```

- **前端**：React 19 ＋ TypeScript（strict）＋ Vite ＋ styled-components，和淡江牌桌同一套；由同一個 Worker 的靜態資產提供（A1 起；原規劃是 Pages，理由見 `DEPLOY.md`）。路由：`/`（首頁）、`/r/:roomId`（會議室）、`/admin`（擁有者的遙測頁，D3，lazy chunk）、`/me`（登入者的房間與錄影，M1）。
- **Worker**：HTTP API 與 WebSocket 升級（建房與升級前先過濫用防護，問全站一個的 `GuardDO`，I1）；把 `/api/rooms/<id>/ws?v=<協定版本>` 的 WebSocket 轉給該房的 Durable Object（`idFromName(<id>)`）。WebSocket 放在 `/api/*` 底下，`run_worker_first` 不必另外列路徑；`/r/:roomId` 只是前端路由。
- **RoomDO**：單一房間的真相來源。狀態：成員（id、名字、角色、連線狀態、心跳時間）、每位成員的軌道（mic／cam／screen 的 on/off 與 SFU track id）、等候室、鎖房、聊天 200 則、標註與白板（M2）、錄影狀態。用 `alarm()` 做空房關閉與計時。推送只送差異（和牌桌 `views.ts` 同一手法）。
- **RoomDO 現況（A3）**：`worker/room.ts` 只是接 Cloudflare 的膠水（storage、alarm、hibernation WebSocket，每個 socket 以成員 id 為 tag、attachment 存成員資料，醒來時從 socket 重建成員）；房間邏輯在 `worker/room-host.ts` 的純類別 `RoomHost`，Vitest 直接測。訊息型別在 `shared/protocol.ts`（有版本號，連線帶 `?v=`，版本不合以 4400 關閉）；差異是 `shared/patch.ts` 的 `set`／`del` 路徑操作，每個 patch 帶遞增 `rev`，瀏覽器發現缺號就送 `resync` 拿 `snapshot`。storage 只存房間資訊與 `rev`；成員不寫 storage。房間 id 是 10 碼 base58（去掉 0、O、I、l，約 58.6 bits），由 `POST /api/rooms` 產生並在 RoomDO 初始化；沒建過的 id 連 WebSocket 以 4404 關閉。
- **Realtime SFU**：每位成員一個 SFU session；發布自己的軌（push），依 RoomDO 告知的 track id 訂閱別人的軌（pull）。SFU 的 API 呼叫由 Worker 代理（App token 不進瀏覽器）。
- **媒體現況（B1）**：代理在 `/api/sfu/<roomId>/*`，每個呼叫帶成員的 session token，由該房 RoomDO 判斷（只服務房內成員、session 屬於建立它的成員、只能 pull 同房的軌；`docs/adr-001-media-layer.md`）。瀏覽器發布後送 `tracks`（協定 v3），RoomDO 把它放進 `Member.tracks` 推給大家；瀏覽器端 `src/room/RoomMedia.ts` 以 desired（RoomDO 的軌清單）／actual（transport 已訂閱）對齊來訂閱與退訂。
- **開關與裝置（B2）**：協定 v4 的每條軌帶 `muted`。關麥克風或鏡頭不取消發布：`MediaTransport.replaceTrack` 改送 null（不重新協商，訂閱者不用重訂），再送一次 `tracks`（`muted: true`），狀態存在 RoomDO。切換裝置也是 `replaceTrack`。本機裝置由 `src/room/LocalDevices.ts` 管：麥克風靜音時保持開啟（解除靜音不延遲），鏡頭關掉時停止裝置（燈會熄）；裝置被拔掉（track `ended`）就改用同類的另一個，沒有就關掉並提示，接上新裝置（`devicechange`）時自動補回；進房時剛被預先加入頁釋放的裝置若「找不到／被佔用」，600 ms 後安靜地再試一次；選擇存 localStorage（`longtalk.devices`），和預先加入頁共用。伺服器估算流出時不算 muted 的軌。
- **版面與講話偵測（C1）**：格狀版面是 `shared/layout.ts` 的純函式（人數＋容器尺寸 → 欄、列、格子大小），會議室頁的 `Stage` 以 `ResizeObserver` 量舞台、CSS 排格子，JS 不逐格定位。講話外框在瀏覽器本機算：`src/media/speaking.ts` 把每個格子的麥克風軌（自己的本機軌、別人收到的軌）接到同一個 `AudioContext` 的 analyser，一個 100 ms 計時器讀全部，門檻＋300 ms 防抖，只在變化時通知 React；不經過伺服器，也不需要 SFU 的 audio level 統計。
- **房間生命週期與排程（C2，`e1-t04`）**：RoomDO 只有一個 alarm；`worker/scheduler.ts` 的 `Scheduler` 記每個工作的到期時間（`sweep` 每 15 秒、`close` 空房 10 分鐘、`handoff` 主持人斷線 60 秒；之後的移出期限等也加一個 key），存在 storage 的 `schedule`，RoomDO 在每次變動後把 alarm 移到最早的那個。空房＝沒有成員（含重新連線中）也沒有未加入的 socket；建立後沒人進來也算。到期時清掉整個 storage，之後這個 id 回 404／4404。主持人（`Member.role`，協定 v6）：第一位加入者；主動離開立即、斷線 60 秒後交給最早加入且在線的成員，回來的前主持人是一般成員；沒有人在線時角色先空著，第一個連上的人接手。改房名（`renameRoom`）的權限 F1 起查 `worker/roles.ts`。
- **螢幕分享（D1，協定 v7）**：誰在分享只存在 RoomDO（`RoomInfo.share`），一次一人。瀏覽器在選擇器選好畫面後送 `share`（有人在分享時要使用者先確認接手，帶 `takeOver: true`；沒帶就回 `share_busy`）；房間指定它是分享者之後它才 `publish({ kind: 'screen' })`（和鏡頭一樣只送 VP8）並列進 `tracks`。不是分享者列的 `screen`／`screenAudio` 會被 RoomDO 濾掉；接手在同一個 patch 裡移交並拿掉前一位的畫面。`unshare`、離開、寬限期滿被移除都結束分享。分享者自己不顯示自己的分享（避免無限鏡像；簡報者檢視是 `e3-t08`）。版面是 `shared/layout.ts` 的 `shareLayout`。主持人停止別人的分享是 `RoomHost.stopShare`，F1 起由 `host` 訊息呼叫。
- **多人分享、文字／動態、簡報者檢視（H5，協定 v15，`e3-t06`–`e3-t09`）**：`RoomInfo.share` 換成 `RoomInfo.shares`（以成員 id 為 key），RoomDO 最多讓 3 人（`MAX_SHARES`）同時分享，第四人回 `share_full`；不再有接手（`share` 沒有 `takeOver`）。主區放誰是每個瀏覽器自己的事（`shareSlots`：觀看者選的，否則最新的；其他分享在側列最前面），選層照 H1 的大小規則（主區 `f`、側列 `h`），主區的分享在完整預算下不降層。文字／動態只在分享者的瀏覽器：`ScreenShare` 記模式，`RoomMedia` 經 `MediaTransport.setShareMode` 套到已發布的分享（`contentHint`＋`setParameters`，不重新協商）。分享者的瀏覽器每秒從本機擷取一張小圖（`shareSampler.ts`）：提示條上的簡報者縮圖，也拿來判斷畫面是否一直在動（動態內容提示）。分享到會議本身（Capture Handle、視窗標題、整個螢幕且會議在前面）時提示條提醒並可「換一個畫面」（同一條軌 `replaceTrack`，分享不中斷）。細節與量測在 ADR-001「分享模式與多人分享」。
- **聊天（D3，協定 v8，`e5-t01`、`e5-t02`）**：訊息模型在 `shared/chat.ts`（id 遞增、寄件者 id、送出時的名字、純文字、伺服器時間）。RoomDO 收 `chat` 時先過速率限制（每人每 10 秒 10 則，`ChatRateLimit`，只在記憶體；超過回 `rate_limited`），文字在兩端都用 `normalizeChatText`（≤ 2000 字、去掉控制字元與雙向覆寫字元、保留換行），再發給全房（含寄件者，當作確認）。保留最近 200 則，每則存成自己的 storage key（`chat:<id>`，超過 200 刪最舊的），所以 hibernation 與逐出後都還在；房間關閉時跟著清掉。**聊天不走 `RoomView` 與 patch**：每次 `welcome` 之後 RoomDO 另外送歷史（`chat` 訊息，每段 ≤ 50 則，第一段帶 `reset`），重新連線的人也一起補上漏掉的。瀏覽器只當文字顯示（React 文字節點，不用 innerHTML），只有 http／https 網址變成 `target="_blank" rel="noopener noreferrer"` 的連結（`src/room/chatText.ts`）。桌機是舞台右側 320 px 的 `SidePanel`（舞台跟著變窄）、手機是全螢幕 `Drawer`；未讀數與氣泡預覽在 `useChatNotifications`（進房時已有的歷史不算未讀）。
- **最小遙測（D3，`e11-t03`）**：自架、不用第三方帳號。瀏覽器（`src/telemetry.ts`）把事件（進房成功／失敗原因、重新連線、媒體重建、是否走 TURN、未攔截的錯誤）每 10 秒一批 `POST /api/events`；Worker（`worker/events.ts`）驗證格式與大小、只收同站，交給全站一個的 `TelemetryDO`（每個 IP 雜湊的速率限制、每小時與每天的計數、最近的錯誤），收下的事件也寫進 Workers Analytics Engine（綁定 `EVENTS`，選用；帳號要先啟用，目前在 `wrangler.jsonc` 註解掉）。`/admin`（lazy chunk）以 `ADMIN_TOKEN`（Worker secret，`Authorization` 標頭、常數時間比對）讀 `GET /api/admin/summary`，警示是頁面上的紅字旗標。不記名字、房號、聊天內容、IP。細節在 `DEPLOY.md` §8。
- **UsageDO（B1，`e11-t13`）**：整個部署一個（`idFromName('global')`），記這個月（UTC）的 Realtime 流出估算；每間房的 alarm 每 15 秒把「瀏覽器回報的 `bytesReceived` 增量」與「伺服器估算（時間 × 收的軌 × 假設位元率）」取大者交給它。達門檻後 `RoomView.usage` 變成 `low`（鏡頭低畫質）或 `audioOnly`（代理拒絕新的視訊軌）。細節與門檻在 `DEPLOY.md` §6。
- **TURN**：Worker 發短期憑證給瀏覽器；ICE 設定一律含 TURN，只在直連失敗時用到。
- **R2**：聊天檔案（24 小時）、雲端錄影（有效期）、白板匯出。
- **錄影（M2）**：ADR 待寫（`e8-t04`）：Realtime 的錄製能力 vs 自架 headless 瀏覽器合成。M1 的本機錄影完全在瀏覽器（Canvas＋Web Audio＋MediaRecorder）。
- **本機錄影（I4，`e8-t01`–`e8-t03`，協定 v17）**：誰在錄是 RoomDO 的狀態（`RoomInfo.recordings`：誰、何時開始），只有主持人（`roles.ts` 的 `record`）或主持人允許的成員（`Member.mayRecord`，`allowRecord`）能開始；瀏覽器先送 `record`，**等 RoomDO 把自己列進去才開始錄**，所以每個人（含預先加入頁的 `GET /api/rooms/<id>`）在第一個畫格前就看到紅燈。主持人 `stopRecording` 任何人的錄影（錄的人收到 `notice` 後自己停並下載）；錄的人離開、或斷線超過 60 秒寬限就結束；v16 的瀏覽器看不到紅燈，連線時就被 `versionMismatch` 擋下。錄影本身全在錄的人的瀏覽器、lazy 載入（`src/record/`）：`scene.ts` 用 `shared/layout.ts` 的 `gridLayout`／`speakerLayout`／`shareLayout` 排版，`composer.ts` 每格畫在同一張 canvas（30 fps，省電 15 fps，時鐘在 Worker 裡、背景分頁也不慢下來；每條軌一個不進 DOM 的 `<video>`），`mixer.ts` 用 Web Audio 把所有遠端麥克風、分享音訊與自己的麥克風混成一條，`recorder.ts` 用 `MediaRecorder`（`format.ts` 依 `isTypeSupported` 挑 WebM VP9／VP8＋Opus 或 Safari 的 MP4）每 4 秒交一段，`store.ts` 立刻寫進 IndexedDB、不留在記憶體；停止時從 IndexedDB 組成檔案下載（WebM 補上長度，`webmDuration.ts`）。分頁當掉或重新整理留下的錄影，下次在首頁或會議室提供「下載上次未完成的錄影」（Web Locks 判斷哪些還在錄）。
- **遠端控制（M3）**：Tauri 桌面端代理作為「另一種客戶端」連進同一個 RoomDO，發布螢幕軌、接收控制事件（DataChannel 或 WebSocket，簽章）。

## 3. 為什麼是 Cloudflare Realtime SFU（而不是 P2P mesh 或自架）

| 選項 | 優點 | 缺點 | 判斷 |
| --- | --- | --- | --- |
| P2P mesh（沒有伺服器） | 最省、零成本 | 每人上傳 N−1 份視訊，4 人就吃力、8 人不可能；之後一定重寫 | 不採用；連 M0 都不用，避免重寫 |
| **Cloudflare Realtime SFU** | Anycast 全球節點、免費流量額度、無主機可維運、與 Workers／DO 同一生態、TURN 同家 | 封閉服務、功能比 LiveKit 少（沒有內建錄製管線、沒有 SDK 幫做 simulcast 選層）、價格可能變 | **第一選擇**。缺的功能自己在 RoomDO 與前端做 |
| LiveKit Cloud | 功能最齊（simulcast、錄製 egress、SDK） | 免費額度較小、第二家供應商、帳號與計費另一套 | 後備；`MediaTransport` 介面保留可切換 |
| 自架 LiveKit／mediasoup | 完全掌控、無限流量 | 要一台有公網 IP 的主機、要維運、要自己做 TURN | 不採用，除非流量超過免費額度且付費更貴 |

**規則**：所有媒體相關的呼叫經過 `src/media/MediaTransport.ts` 介面（`connect`、`publish`、`unpublish`、`subscribe`、`unsubscribe`、`setPreferredLayer`、`getStats`、`on`、`close`）。`CloudflareRealtimeTransport` 是第一個實作；介面的測試用 `FakeTransport` 跑。**A2 定稿：決定、Realtime 實際端點、介面與切換條件見 [`adr-001-media-layer.md`](adr-001-media-layer.md)。**

**Simulcast（H1）**：鏡頭以 1280×720 擷取、發三層（`f`／`h`／`q`），分享兩層，都是 VP8（`src/media/encoding.ts`）。每個接收端自己選層：格子把畫出的大小與是否看得見報給 `VideoDemandStore`（`src/components/useVideoDemand.ts`），`RoomMedia` 用 `src/media/layers.ts` 的純函式（大小、可見、每人 3.4 Mbps 的視訊下行預算、遲滯）決定，經 `MediaTransport.setPreferredLayer` 對 SFU 的 `tracks/update` 送出；SFU 照要的層送（`priorityOrdering: none`），頻寬比預算少時降低預算（H2，下一段）。層是接收端與 SFU 之間的事，RoomDO 不參與。細節與實測在 ADR-001「Simulcast」。

**發送端的品質設定（H3）**：麥克風的噪音抑制、回音消除、自動增益是 `getUserMedia` 約束（`src/media/audioProcessing.ts`），通話中先 `applyConstraints`、瀏覽器不肯改就重開麥克風再 `replaceTrack`（不重新協商）。HD 是鏡頭的最高層：`MediaTransport.setTopLayer` 用 `setParameters` 開關 `f` 層（關＝最高 360p），HD 開著時 `RoomMedia` 每 5 秒從最新的統計樣本（H2，下一段）讀 `qualityLimitationReason` 與 `availableOutgoingBitrate`，上行不夠就暫停 HD 並稍後再試（`src/media/uplink.ts`）。純音訊模式（`RoomMedia.setAudioOnly`）退訂所有別人的視訊、自己的鏡頭送 null；聲音照常。靜音中講話提醒用麥克風的 `clone()` 在本機分析，什麼都不送。都只在瀏覽器裡，RoomDO 不參與（`muted` 照常回報）。

**統計、訊號格與頻寬自適應（H2）**：`RoomMedia` 每 2 秒讀一次 `MediaTransport.getStats()`（全部的統計只有這一條路：免費額度回報、HD 上行檢查也用它），`src/media/stats.ts` 算出每條軌的位元率、丟包、卡頓，`src/media/quality.ts` 判好／普通／差。自己的名牌用自己的判斷，別人的由各自的瀏覽器經 `signal`（協定 v14，變了才送、最多每 5 秒，RoomDO 限速）放進 `Member.signal`。「更多 › 連線統計」是 lazy 載入的面板，讀 `StatsStore`（不經 React 狀態，面板關著時沒有重繪）。`src/media/adaptation.ts` 兩個純狀態機：下行有丟包時先降選層預算、再退訂講話者／釘選以外的鏡頭、最後建議 H3 的純音訊；上行受限時用 `setTopLayer` 關最高層；聲音不動。判斷都在瀏覽器，RoomDO 只轉訊號格的等級。細節與實測在 ADR-001「統計與頻寬自適應」。

**進階噪音抑制與省電模式（H4）**：打開「進階噪音抑制」時才 lazy 載入管線（`src/media/noiseSuppression.ts`）、AudioWorklet（`rnnoise.worklet.ts`）與 RNNoise 的 wasm（BSD-3，放在自己的 `/assets/`，授權在 `THIRD_PARTY_NOTICES.md`）：麥克風 → 48 kHz `AudioContext` → worklet（480 樣本一幀，延遲約 9 ms）→ `MediaStreamDestination`，它的軌經 `RoomMedia.setLocal` → `replaceTrack` 取代麥克風（不重新協商；準備好之前、context 沒在跑時照送麥克風本身）。開著時瀏覽器自己的噪音抑制暫停；worklet 每秒回報負載，連續 5 秒超標就關掉並提示（`noiseLoad.ts`）。省電模式（`src/media/powerSaving.ts`、`RoomMedia.setPowerSaving`）：選層預算 0（收到的都是最低層）、不送 HD、鏡頭擷取 15 fps，頁面關動畫（`MotionOffContext`）並暫停進階噪音抑制。都在瀏覽器，RoomDO 不參與。細節在 ADR-001「進階噪音抑制與省電模式」。

## 4. 資料流：一個人進房

1. 瀏覽器 `GET /r/abc123` → Worker 的靜態資產回 SPA。
2. 預先加入頁先 `GET /api/rooms/abc123` 確認房間存在（順便拿人數）才開鏡頭。按「加入」後開 WebSocket `/api/rooms/abc123/ws?v=12`（Worker 檢查 `Origin` 後轉給 RoomDO），第一則訊息是 `join`（名字、這個分頁上次拿到的 session token、這個瀏覽器的 id（F1））→ RoomDO 回 `welcome`：成員 id、session token、房間快照（A4 起）。房間快照含主持人（`Member.role`）、房名與開始時間（C2，協定 v6）。`welcome` 之後緊接著是聊天歷史（D3，協定 v8）。
3. 之後所有狀態變化走這條 WebSocket。
4. 瀏覽器先 `POST /api/turn/abc123`（帶 session token，B3 起）拿 ICE 伺服器：Worker 用 TURN key 向 Cloudflare 要 3 小時的短期憑證（沒設定就只給 STUN），再經 `/api/sfu/abc123/sessions`（帶 session token）建立 SFU session（RoomDO 記成這個成員的），發布 mic／cam 軌；把軌清單回報 RoomDO（`tracks` 訊息，B1 起）。
5. RoomDO 以 patch 推送 `Member.tracks`；其他瀏覽器向 SFU 訂閱該軌（代理確認那條軌屬於同一間房）。瀏覽器每 10 秒送 `stats`（收到的 bytes、是否走 TURN），給免費額度保護記帳。
6. 心跳每 15 秒（文字 `ping`，由 runtime 自動回 `pong`，不喚醒 DO；每 15 秒的 alarm 讀 `getWebSocketAutoResponseTimestamp` 檢查，45 秒沒心跳就關 socket 並移除成員）；A4 起：socket 關閉但沒有先送 `leave`（重新整理、斷網、心跳逾時）時，RoomDO 保留成員 60 秒並標示「重新連線中」；回來後以同一 session token 接回，超過 60 秒由 alarm 移除；送 `leave` 立即移除。成員與 session 存在 DO storage。
   **B3 起瀏覽器自己重連**（`src/room/RoomConnection.ts`）：socket 斷掉（4404／4409／4400／4410／4403／4411／4423／4406／4412／4401／4402／4429 以外）就以 1、2、4、8 秒（上限，±25% 抖動）退避重開、帶同一 token，60 秒內接回就是同一成員、同一份軌清單；心跳到下一次還沒回、瀏覽器 `offline`、回到前景時 5 秒內沒回 `pong`，都當作 socket 已死；`online` 與回到前景立即重試；超過 60 秒放棄，畫面給「重試」。接回後瀏覽器重送 `tracks`（斷線期間的開關）。媒體另外處理（`src/room/RoomMedia.ts`）：PeerConnection `failed`，或 `disconnected` 超過 4 秒，就丟掉這個 SFU session 重建（重新拿 ICE 伺服器、建 session、重新發布、從 RoomDO 的軌清單重新訂閱），一樣退避與 60 秒上限。WebSocket 斷線不影響媒體：PeerConnection 還活著就繼續收發。別人看到「重新連線中」的時間點是 RoomDO 發現 socket 關閉的時候：重新整理、瀏覽器判定離線會立刻關；網路默默斷掉要等心跳逾時（最多約 60 秒）。
7. 最後一人離開（或重新連線的寬限到期）10 分鐘後，`alarm()` 清房間（C2 起；持久房間是 M1 的 `e1-t13`）。

## 5. 安全邊界

- SFU App token、R2 憑證、Turnstile secret key、`ADMIN_TOKEN`、`IP_HASH_PEPPER` 只在 Worker；瀏覽器只拿短期、限範圍的憑證。`npm run lint` 的 `scripts/secrets.ts` 擋 `src/`、`public/` 裡的 secret 名稱與像 secret 的值，`npm run budget` 再掃一次 build 出來的 `dist/client`（I1）。
- 誰能靜音別人、踢人、開始錄影、取得標註權限：只在 RoomDO 判斷（`roles.ts`），前端只是按鈕。
- **權限表與主持人控制（F1，協定 v9，`e1-t06`–`e1-t08`）**：角色 `host`／`cohost`／`participant`／`waiting` × 25 個動作的表在 `shared/roles.ts`（含之後批次的列，`since` 寫哪一批接上）；對某人的動作另外要求對方等級比自己低、不能對自己。RoomDO 每個動作都經 `worker/roles.ts` 的 `authorize`（改房名、聊天、分享、SFU 代理的 `media`、主持人控制），不允許回 `forbidden`；瀏覽器讀同一張表只為了不顯示用不到的按鈕。主持人控制是 `host` 訊息：`muteMember`／`camOff` 在 RoomDO 把那條軌標成 `muted`（大家立刻看到）並送 `notice` 給本人，本人的瀏覽器自己關掉裝置並顯示提示；伺服器不能也不會幫人打開，只有本人能再開（重新連線中的成員收不到 `notice`，回來時自己的狀態會蓋過去，反正本人本來就能再開）。`muteAll` 是等級比自己低的每個人。`stopShare` 呼叫 `RoomHost.stopShare` 並送 `notice`。`remove` 以 4403（`removed`）關掉對方、移除成員，並把對方瀏覽器的 id（每次 `join` 帶的 `client`，`src/room/session.ts` 存在 localStorage 的 16 bytes 亂數）列入 ban 名單 10 分鐘（storage `bans`，最多 200 筆，排程器的 `bans` 工作到期清掉；同一瀏覽器再 `join` 一律 4403）。沒有帳號，所以私密視窗、換瀏覽器、清除網站資料都能繞過；不用 IP 是因為同一個家庭或公司網路的其他人會一起被擋。`endMeeting` 只有主持人：所有 socket 以 4411（`ended`）關閉，房間像空房到期一樣立即清空，之後 404；F3 起留 10 分鐘的墓碑（storage `ended`），這段時間重新連線的人回來也是 4411。
- **鎖房與等候室（F2，協定 v10，`e1-t09`–`e1-t11`）**：`RoomInfo.locked`／`waitingRoom` 只存在 RoomDO，`host` 訊息的 `lock`／`waitingRoom`（`on`）切換，`admit`／`admitAll`／`deny` 決定等候中的人，都經 `authorize`（`lockRoom`、`waitingRoom`、`admit`）。**鎖住**：不認得的 token 以 4423 關掉（連等候室也進不去）；寬限期內帶 token 回來的成員、已在等候的人不受影響。**等候室**：新進者是角色 `waiting` 的成員（和其他人一樣有 session、寬限期、存在 storage），但不在 `RoomView.members`，而在 `RoomView.waiting`（id、名字、開始等的時間、重新連線中）；他的 socket 收不到 `welcome`、patch、聊天，只收 `lobby`（排第幾、共幾人、房名、有沒有在線的主持人或共同主持人），RoomDO 在每次 `publish` 後比對、有變才送；`resync` 也只回 `lobby`。SFU 代理與 TURN 經 `media` 拒絕（403）。放行：角色改成 `participant`、加入時間改成現在，先送其他人的 patch，再送他自己的 `welcome` 與聊天歷史（同一個 socket）。拒絕：4406，瀏覽器 id 進 `bans`（`denied: true`，60 秒）。關掉等候室時放行全部。排程器的 `waiting` 工作在最早一位等滿 15 分鐘時以 4412 請他離開。主持人交接（C2）只在房內成員之間，等候中的人不會變主持人、也不算「有人在線」。
- **房間密碼、共同主持人、結束會議（F3，協定 v12，`e1-t15`–`e1-t17`）**：密碼只有主持人能設（`host` `setPassword`），RoomDO 只存加鹽的 SHA-256（`worker/password.ts`，固定時間比對），大家只看得到 `RoomInfo.passwordSetAt`。新進者的密碼只在 `join` 訊息裡（不進任何 URL、不寫 log）；`join` 的檢查順序是 ban → 認得的 token（不再問密碼）→ 鎖房 → 密碼 → 等候室。連錯 3 次（同一瀏覽器 id 或同一網路位址的雜湊）要等 30 秒（`PasswordGuard`，存在 storage `guesses`）。瀏覽器的 `?pwd=` 在 `main.tsx` 一開始就以 `history.replaceState` 拿掉（`src/room/roomPassword.ts`）。共同主持人由主持人指定（`setCohost`），主持人可移交（`makeHost`，前主持人變共同主持人）；被指定的人先收到 `notice` 再收到 patch。主持人離開時交給 `leave.host` 指定的人，否則最早進房的在線共同主持人、再來最早進房的在線成員。`endMeeting` 之後的墓碑見上一條。
- **反應與舉手（G3，協定 v13，`e5-t03`、`e5-t04`）**：反應（`react`，`shared/reactions.ts` 的六種）經 `authorize` 的 `react`，RoomDO 以 `ChatRateLimit` 每人每 5 秒最多 8 個（記憶體，逐出就忘，只會讓人早一點能送），轉成 `reaction`（送出者 id＋emoji）送給房裡每一個人（含送出者，等於回執）；超過、等候室的人都**直接丟、不回錯誤**；**不存任何地方**，不在 RoomView、不在 storage，後來的人看不到。浮出、合併、隱藏與 `prefers-reduced-motion` 都是瀏覽器自己的事（`src/room/useReactions.ts`、`floatingReactions.ts`）。舉手是 `Member.hand`（舉手時間，伺服器的時鐘；放下是 null），跟著 session 存在 storage（逐出後還在、重連中保留、離開就沒了；v12 存的成員讀成 null）；`hand` 訊息（`up`）經 `raiseHand`，已經舉著再舉不改時間（不插隊）；順序是 `handQueue`（時間、同時依 id，每一端都一樣）。`host` `lowerHand` 經 `lowerHand`（對某人的動作：主持人、共同主持人，對方等級要比較低，不能對自己），只有手真的舉著才改並送 `notice` `handLowered`。舉手的通知（toast、音效）由瀏覽器比對前後兩個 view 決定（`src/room/roomEvents.ts`），每次 `welcome` 後的第一個 view 不算變化。
- **聚光燈（G2，協定 v11，`e4-t11`）**：`RoomInfo.spotlight`（成員 id 或 null）只存在 RoomDO；`spotlight` 訊息（`memberId` 或 null）經 `authorize` 的 `spotlight`（權限表第 26 列，主持人、共同主持人；是對全房的動作，不比等級，可以聚光自己或主持人），對象不是房裡的成員（已離開、還在等候室）一樣回 `forbidden`；那個人離開或被移出時清掉，重連中保留，存在 storage（逐出後還在）。怎麼顯示是每個瀏覽器自己決定：`shared/layout.ts` 的 `visibleTiles`（隱藏自己、隱藏沒有視訊的人，被釘選與聚光燈的人一定顯示）、`stageFocus`（自己的釘選 ＞ 聚光燈 ＞ 最後講話的人，`holdSpeaker` 讓大格至少停 3 秒）、`stageLayout`（釘選或聚光燈把任何版面換成演講者；手機照 C3）。釘選不送到伺服器。
- **濫用防護（I1，協定 v16，`e11-t05`）**：每個用戶端以**網路**為單位（IPv4 一個位址、IPv6 一個 /64），只存雜湊（`worker/client-key.ts`：有 `IP_HASH_PEPPER` secret 時是 HMAC-SHA-256，否則加固定標籤的 SHA-256；取 96 bits），從不存位址。全站一個 `GuardDO`（`worker/guard-do.ts`、規則在 `worker/guard.ts`）記：每個網路建房的時間（10 分鐘 10 間、一天 60 間，`shared/abuse.ts` `ROOM_CREATE_LIMITS`）、封鎖名單（雜湊＋到期時間＋備註，最多 500 筆）、最近碰到限制的 50 個網路（給 `/admin`）。`POST /api/rooms` 的順序：封鎖 → Turnstile（兩把 key 都設了才開；沒有 token 回 403 `turnstile_required` 帶 site key，瀏覽器才載入 Turnstile 的 script 拿 token 再送一次；Worker 用 secret key 問 siteverify，失敗回 403 `turnstile_failed`，siteverify 連不上也算失敗）→ GuardDO 的建房限制（429 `rate_limited`＋`Retry-After`）→ 建房。封鎖的網路在 `/api/rooms/*`（建房、預先加入頁的查詢、WebSocket 升級）一律 403 `blocked`；每個 Worker isolate 每 30 秒最多讀一次名單（GuardDO 連不上時沿用上一份或不擋）；已經在會議裡的連線不會被踢。`/api/rooms/<id>` 與升級另有每個 isolate 的記憶體限制（每網路 10 秒 60 次，只是第一道防線）。RoomDO 再擋兩件事：同一網路進同一房每分鐘最多 60 次升級（超過以 4420 `rateLimited` 關閉）、每個連線每 10 秒最多 120 個訊息（全部種類合計；心跳 `ping` 由 runtime 自動回、不算）超過也是 4420，瀏覽器收到 4420 不重連，請使用者等一分鐘再重新整理；超過 `MAX_CLIENT_MESSAGE_CHARS` 的訊息以 1009 關閉。各訊息種類原本的限制不變（聊天每人 10 秒 10 則、反應 5 秒 8 個、`signal` 10 秒 3 個、密碼錯 3 次等 30 秒）。碰到限制的網路由 RoomDO／Worker 告訴 GuardDO（不等回應），擁有者在 `/admin` 看得到並可封鎖（輸入位址由 Worker 雜湊，或直接封鎖名單上的雜湊）。沒有 `CF-Connecting-IP` 的請求（本機開發、測試）不受這些限制。`DEPLOY.md` §11。
- **安全標頭（I1，`e11-t06`）**：頁面與靜態檔由 `public/_headers` 加（Workers Static Assets 直接回應、不經 Worker），內容等於 `shared/security-headers.ts` 的 `PAGE_HEADERS`（測試比對）：CSP（script 只有自己與 Turnstile、加 `'wasm-unsafe-eval'` 給 RNNoise；style 允許 inline，因為 styled-components 在執行時寫 `<style>`；connect 只有自己——SFU 與 TURN 的 API 都經 Worker 代理，媒體走 ICE 不受 CSP 管；frame 只有 Turnstile；`frame-ancestors 'none'`）、HSTS、Permissions-Policy（鏡頭、麥克風、螢幕擷取只給自己，用不到的關掉）、COOP `same-origin`、Referrer-Policy、nosniff。Worker 自己的回應（`/api/*`）加 `API_HEADERS`（`default-src 'none'`）。CSP 違規回報到 `/api/csp-report`，變成遙測的錯誤事件（名稱 `CSP`，只留指令與被擋來源的網域）。
- 房間 id 用 URL-safe 的 10 字元隨機字串（約 59 bits），不可列舉；再加上鎖房、等候室（F2）與密碼（F3，上一條）。
- 錄影、逐字稿、遠端控制三件事一律「全員可見的狀態 ＋ 明確同意」，寫進 RoomDO 狀態而不是前端旗標。本機錄影（I4）：紅燈與名字在頂部條；RoomDO 記下每段錄影誰同意了（`RecordingInfo.consented`），還沒同意的人會議室被問題擋住（「同意並留在會議」／「離開會議」），預先加入頁要先勾同意，60 秒沒同意由 RoomDO 移出（`recordingDeclined`）；錄的人不錄沒同意的人的鏡頭與聲音；錄影檔只在錄的人的裝置，伺服器不經手任何媒體。

## 6. 成本模型（粗估，動工後以儀表板為準）

| 項目 | 假設 | 每月免費額度（規劃時） | 說明 |
| --- | --- | --- | --- |
| SFU 流出 | 4 人、720p 1.5 Mbps、每人收 3 路 ⇒ 18 Mbps ⇒ 2 小時約 16 GB | 1 TB | 約 60 場 4 人 2 小時；8 人會議約 4 倍流量，simulcast 後接收端可降層（H1：格狀的格子多半收 360p 約 0.3–0.4 Mbps、每人視訊下行上限 3.4 Mbps） |
| TURN | 10–15% 的連線走 TURN | 1 TB（和 SFU 共用） | TURN 與 SFU 之間的流量不重複計費（Cloudflare 定價頁），計的是 TURN 到瀏覽器的流出；保護把走 TURN 的接收端 ×1.1（框架開銷） |
| Workers／DO | 每房一個 DO，每秒數則訊息 | 免費方案 | 和牌桌同等級 |
| R2 | 聊天檔案 24 小時、錄影有效期 | 10 GB | 雲端錄影是主要用量，M2 才有 |

超額時的自動降級順序（E11 `e11-t09`）：關雲端錄影 → 限制 HD → 降低 simulcast 最高層 → 限制人數。

**B1 起的保護（擁有者決定只用免費額度）**：SFU＋TURN 共用 1,000 GB；`UsageDO` 每月計數，800 GB 起鏡頭低畫質、950 GB 起不再建立新的視訊軌（只留音訊），每月 1 日（UTC）歸零，`GET /api/usage` 可查（`DEPLOY.md` §6）。

## 7. 與淡江牌桌的關係

同一套技術與文件方法，**不共用程式碼與帳號**（使用者群不同）。可以複製的：WebSocket 差異推送、心跳與重連、`roles.ts` 的權限表寫法、Playwright 視覺回歸、CI 效能預算腳本。
