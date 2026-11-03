---
title: ADR-001 — 媒體層：Cloudflare Realtime SFU
date: 2026-10-30
status: accepted（2026-11-02 兩台裝置實測通過：電腦 Chrome ＋ 手機 Chrome 經 Realtime SFU 互通，見 PR #8）
task: e2-t01
---

# ADR-001 — 媒體層：Cloudflare Realtime SFU

## 背景

LongTalk 的核心是 2–8 人（M0／M1）的音訊、視訊與螢幕分享，之後要擴到大房間（E10）。媒體層要選一個轉送方式，而且一旦選了，發布、訂閱、重連、選層、統計都長在它上面。`docs/ARCHITECTURE.md` §3 已有初步判斷；這份 ADR 在 A2 spike 之後定稿，並確認 Cloudflare Realtime 的實際 API。

限制條件：

- 一個人維運、免費方案優先（`00-prd.md`）；後端已經是 Cloudflare Worker ＋ Durable Object（A1）。
- secrets 不進前端（CLAUDE.md 規則 3）；權限只在 RoomDO（規則 1）。
- 會議室頁 JS ≤ 350 kB gzip（規則 6）。

## 選項

| 選項 | 怎麼運作 | 優點 | 缺點 |
| --- | --- | --- | --- |
| **P2P mesh** | 每兩人之間一條 PeerConnection | 零伺服器成本、最簡單 | 每人上傳 N−1 份視訊：4 人已吃力、8 人不可行；沒有 simulcast 選層；之後一定重寫 |
| **Cloudflare Realtime SFU** | 每人一個 SFU session（一條 PeerConnection），push 自己的軌、pull 別人的軌；Worker 用 HTTPS API 控制 | 全球 anycast、沒有主機可維運；**每月前 1,000 GB 流出免費，之後 $0.05／GB（SFU 與 TURN 共用額度）**；TURN 同家；和 Worker／DO 同一個帳號與部署；不需要客戶端 SDK（原生 WebRTC，零 kB） | 低階：沒有房間、沒有權限、沒有錄製、選層要自己做；文件與範例較少；封閉服務，價格可能變 |
| **Cloudflare RealtimeKit** | Realtime 之上的高階套件（會議、參與者 token、UI Kit、Core SDK） | 內建錄影（composite 或分軌，可存 R2）、即時逐字稿與摘要（Workers AI）、角色與預設 | **按參與者分鐘計費：音視訊 $0.002／人分鐘**（4 人 2 小時 ≈ $0.96），沒有看到免費額度；SDK 會吃掉會議室頁的 JS 預算；房間與權限模型是它的，不是 RoomDO 的 |
| **LiveKit Cloud** | 開源 SFU 的託管版，用它的 SDK | 功能最齊（simulcast 自動選層、egress 錄製、SDK 處理重連） | 第二家供應商與帳號；免費額度較小；SDK 體積大；房間狀態要和 RoomDO 雙寫 |
| **自架 LiveKit／mediasoup** | 自己的主機跑 SFU | 完全掌控、流量不計費 | 要一台有公網 IP 的主機、自己做 TURN、自己維運與更新；一個人顧不來 |

## 決定

**採用 Cloudflare Realtime SFU，客戶端用原生 WebRTC，全部經過 `src/media/MediaTransport.ts` 介面；LiveKit 是後備（`e2-t17`）。** 不用 mesh（連 M0 也不用，NEXT.md §4）；RealtimeKit 不當媒體層，只在 E8 錄影 ADR（`e8-t04`）重新評估它的錄影管線。

理由：

1. **成本**：8 人以內的會議在 1 TB 免費額度內可以開很多場（`ARCHITECTURE.md` §6）；RealtimeKit 與 LiveKit 是按分鐘計費。
2. **同一個生態**：Worker 代理 SFU API、RoomDO 管軌清單、TURN 憑證也由 Worker 發，沒有第二家帳號。
3. **控制權**：房間、權限、同意都在 RoomDO（規則 1、4），SFU 只轉送封包；換實作不動房間邏輯。
4. **JS 預算**：不需要 SDK，媒體層是自己寫的幾 kB。

## Realtime API（spike 實際用到的端點）

基底 `https://rtc.live.cloudflare.com/v1`，標頭 `Authorization: Bearer <App Secret>`（OpenAPI `realtime-api-2024-05-21`）。**瀏覽器從不直接呼叫**：Worker 在 `/api/sfu/<roomId>/*` 代理（`worker/sfu.ts`），只放行下列路徑並檢查 session id 格式與 body 大小。B1 起每個呼叫都要帶成員的 session token（`Authorization: Bearer …`），由該房的 RoomDO 判斷（見「後果」）。下表的 `/api/sfu` 都是 `/api/sfu/<roomId>` 的簡寫。

| LongTalk（Worker） | Realtime | 用途 |
| --- | --- | --- |
| `POST /api/sfu/sessions` | `POST /apps/{appId}/sessions/new`（不帶 body） | 建立自己的 session，回 `sessionId` |
| `POST /api/sfu/sessions/:id/tracks` | `POST …/sessions/{id}/tracks/new` | **push**：帶瀏覽器的 offer 與 `{location:'local', mid, trackName}`，回 answer，不需要 renegotiate。**pull**：只帶 `{location:'remote', sessionId: 發布者, trackName}`，回 SFU 的 offer 與 `requiresImmediateRenegotiation: true` |
| `PUT /api/sfu/sessions/:id/renegotiate` | `PUT …/renegotiate` | pull 之後把瀏覽器的 answer 送回去 |
| `PUT /api/sfu/sessions/:id/tracks/update` | `PUT …/tracks/update` | 改訂閱的 simulcast 層（`simulcast.preferredRid`） |
| `PUT /api/sfu/sessions/:id/tracks/close` | `PUT …/tracks/close` | 協商式關閉：`transceiver.stop()` → 新 offer ＋ `{tracks:[{mid}], force:false}` → 套用 answer |
| ~~`GET /api/sfu/sessions/:id`~~ | `GET …/sessions/{id}` | A2 spike 用來找對方的 trackName；B1 移除，軌清單由 RoomDO 告知 |

要點：

- **一個 session 一條 PeerConnection，同時 push 與 pull**；`bundlePolicy: 'max-bundle'`。
- **不用 trickle ICE**：送出前等 ICE gathering 完成（上限 1.5 秒）。
- **每個 session 同一時間只能有一次 SDP 交換**：`CloudflareRealtimeTransport` 把所有變更排成一個佇列。一次交換要到「SFU 的 answer 已套用」或「我們對 SFU offer 的 answer 已被 `/renegotiate` 接受」才算結束（Cloudflare〈Negotiation and session lifecycle〉）。
- 錯誤看三層：HTTP 狀態、頂層 `errorCode`、每條軌的 `errorCode`。
- **三人以上才出現的規則**（#13，C1 截圖時發現同房第 3 人起常有人的鏡頭別人收不到）：
  - **送出的視訊只提供 VP8**（`setCodecPreferences`，含 RTX）。PeerConnection 已經收著別人的視訊時再 push 自己的鏡頭，Chrome 會給新的 m-section 重新編 payload type（H264 97、VP9 的 RTX 99），SFU 的 answer 卻沿用它先前 offer 的編號（H264 125、RTX 36），offer 裡沒有這些編號，瀏覽器拒絕套用（`Failed to set remote video description send parameters`）。這是三人房第三人鏡頭送不出去的主因，Playwright 的 headless Chromium 每次都中。只給 VP8 時 answer 沿用 offer 的編號；所有瀏覽器都能解 VP8。螢幕分享（D1，`kind: 'screen'`）走同一條路，也只送 VP8。之後要 H264／VP9／AV1 時要先驗證這點（或改成發布與訂閱各用一條 PeerConnection，Cloudflare 的 video-room 範例就這樣做）。
  - **只要回應帶 SFU 的 offer（`requiresImmediateRenegotiation: true`）就先回答**，不管頂層或軌有沒有錯；不回答的話 session 一直等 answer，之後所有呼叫都回 406「expecting a remote answer」。
  - **發布端要等 sender 真的送出封包（`outbound-rtp.bytesSent > 0`）才把軌告訴房間**（Cloudflare 自己的 partytracks 也這樣做）。太早告訴的話，訂閱端 pull 一條還沒有封包的軌：SFU 會卡住那個 pull 約 8 秒（期間訂閱端自己的佇列也停住，連它的 push 都延後）再回 `empty_track_error`。實測（正式站，4 個 headless Chrome）：一個成員的第一條 PeerConnection 沒連上，push 照樣回 200，其他人 pull 它的軌卡 8 秒後失敗，舊版重試 3 次就放棄。現在 10 秒送不出封包就當連線壞了，transport `failed` 重建。
  - **pull 的 mid 從「那條軌」的結果讀**（比對發布者 session 與 trackName），找不到對應的 transceiver 就是兩邊對 SDP 的認知不同，transport `failed` 重建。
  - **SDP 交換做到一半失敗**（SFU 已收下 offer 但 answer 套不上、`/renegotiate` 被拒、或任何 406）時，瀏覽器與 SFU 不再一致，重試只會一直被拒：transport `failed`，由 `RoomMedia` 重建 session。
  - 「還沒好」（`not_found_track_error`、`empty_track_error`、`track_not_in_room`）的訂閱以退避重試（2、4、8 秒，最多每 15 秒一次），軌還在房間清單上就不放棄；發布失敗也一樣重試。
- **simulcast**：發布端 `sendEncodings` 用 rid `f`／`h`／`q`（1、½、¼ 解析度）；接收端 `preferredRid` 搭配 `priorityOrdering`／`ridNotAvailable: 'asciibetical'`，字母越前面越優先，所以 `f` 是最高層。`Layer` 對應：`high→f`、`medium→h`、`low→q`。
- **TURN**（`e2-t07`）：`POST https://rtc.live.cloudflare.com/v1/turn/keys/{TURN Key ID}/credentials/generate-ice-servers`，標頭 `Authorization: Bearer <TURN Key API Token>`，body `{"ttl": 秒數}`，回 `{ iceServers: [...] }` 直接給 `RTCPeerConnection`。清單可能含 port 53 的 URL，瀏覽器會擋，不用 trickle ICE 時要濾掉。A2 先只用 `stun:stun.cloudflare.com:3478`。**B3 實作**（`worker/turn.ts`、`POST /api/turn/<roomId>`）：只發給帶成員 session token 的呼叫（RoomDO `sfuAccess` 判斷，房外 401），TTL 3 小時、瀏覽器到 2/3 時向 Worker 再要一次並 `setConfiguration`，重建 PeerConnection 時也重新要；port 53 的 URL 在 Worker 濾掉；沒有 TURN secret 或 Cloudflare 回錯時回 `stun:stun.cloudflare.com:3478`（`turn: false`），通話照常。定價：SFU 與 TURN 共用 1,000 GB，TURN 與 SFU 之間的流量不重複計費。
- **錄製**：Realtime SFU 沒有內建錄影。WebSocket adapter（GA）能把音訊以 PCM、視訊以 JPEG 幀送到自己的 WebSocket 端點：適合即時逐字稿（E8），不適合錄完整視訊。雲端錄影的選項（自架合成 vs RealtimeKit 錄影）留給 `e8-t04`。這回答了 E2「未決問題」的第一題。

## `MediaTransport` 介面（定稿）

```ts
interface MediaTransport {
  readonly sessionId: string | null
  readonly state: ConnectionState // new | connecting | connected | reconnecting | failed | closed
  connect(options?: { iceServers?: RTCIceServer[] }): Promise<void>
  publish(track: MediaStreamTrack, options: { kind: TrackKind; simulcast?: boolean }): Promise<PublishedTrack>
  unpublish(trackName: string): Promise<void>
  replaceTrack(trackName: string, track: MediaStreamTrack | null): Promise<void> // B2
  subscribe(ref: TrackRef): Promise<RemoteTrack>
  unsubscribe(ref: TrackRef): Promise<void>
  setPreferredLayer(ref: TrackRef, layer: 'high' | 'medium' | 'low'): Promise<void>
  getStats(): Promise<TransportStats> // rttMs, usingRelay, bytesSent, bytesReceived
  on(event: 'state' | 'track' | 'trackEnded', handler): () => void
  close(): Promise<void>
}
```

- `TrackRef = { sessionId, trackName }` 是一條軌的全域位址：發布者回報 RoomDO，RoomDO 轉給訂閱者。和 Realtime 的模型一致，換成 LiveKit 時對應到 participant identity ＋ track sid。
- `TrackKind = 'mic' | 'cam' | 'screen' | 'screenAudio'`，給 RoomDO 與介面用；SFU 不需要知道。
- 錯誤一律是 `MediaTransportError`，`code` 為 `not_connected`、`closed`、`not_found`、`sfu_not_configured`、`sfu_error`、`negotiation_failed`；B1 加上 `unauthorized`（代理不認得 session token，或 session 不是自己的）與 `quota_exceeded`（本月免費額度快用完，新的視訊軌被拒，`DEPLOY.md` §6）。
- `TrackKind` B1 起定義在 `shared/protocol.ts`（RoomDO 的軌清單也用它），`MediaTransport.ts` 轉出。`CloudflareRealtimeTransport` 的建構參數必填 `apiBase`（`/api/sfu/<roomId>`）與 `token`（取 session token 的函式）。
- 和 ARCHITECTURE §3 原本的清單相比：加了 `unsubscribe`、`on()`（回傳取消函式）與 `trackEnded` 事件；`stats` 事件拿掉，改由呼叫端每 2 秒 `getStats()`（`e2-t13` 決定節奏）。
- **B2 加上 `replaceTrack`**：換掉已發布的軌實際送出的內容（換裝置），或送 null（靜音、關鏡頭）；`RTCRtpSender.replaceTrack`，不需要 SDP 交換，所以不經過協商佇列，訂閱者的訂閱不受影響。
- `FakeTransport`（`src/media/FakeTransport.ts`）：同一個 `FakeSfu` 建出來的 transport 互相 publish／subscribe，`useRoomMedia`（`e2-t04`）的測試用它跑。

## 編碼參數（2026-11-03 實測後，`src/media/encoding.ts`）

擁有者第一次實測（電腦＋手機＋同一台電腦上的 6 個 bot）回報「分享螢幕卡卡的、視訊一開始很糊、慢慢才變清楚」。量法：#21 的 PR 預覽，同一個 headless Chrome 裡 3 人（Alice 分享、Bob 與 Carol 看），替身 `getDisplayMedia` 是 1920×1080 的 canvas（捲動的文字＋快速移動的方塊，依要求的 fps 畫），每秒讀接收端 `inbound-rtp`（`framesPerSecond`、`framesDropped`、`freezeCount`、解析度）與發送端 `outbound-rtp`（`qualityLimitationReason`、`targetBitrate`）、`candidate-pair.availableOutgoingBitrate`；分享後 30 秒、鏡頭從加入起 20 秒。候選參數先在舊版預覽上以 init script 注入比較，選定後部署再量一次。

| | 改之前（main） | 改之後（#21） |
| --- | --- | --- |
| 分享，接收端平均 fps（無負載） | 15.3；另一次 **1.5**（分享一開始頻寬估計掉到約 100 kbps，`detail` 守住 1080p、幀率掉到 0–3 fps，30 秒都沒回來） | **28.0／29.3**（兩次；從第 2 秒起 1080p） |
| 分享，接收端 kbps | 約 1,200（另一次 212） | 約 2,150 |
| 鏡頭到 640×480 | **13–16 秒**（先 320×240、再 480×360） | **第 0 秒** |
| 8 人同一程序（5 個 bot） | 分享 12.8 fps | 分享 12.8 fps：**替身畫面本身只畫出約 12 fps**（渲染程序 CPU 不夠），編碼器沒有受限（`qualityLimitationReason: none`、`targetBitrate` 頂到 2.5 Mbps）；這個負載量到的是測試機，不是網路或編碼 |

決定（候選比較的數字在 #21）：

- **分享**：`frameRate { ideal: 30, max: 30 }`（原本 15）；`contentHint` 留 `detail`（`motion` 或不設時前 14 秒只有 720p，字糊；`detail`＋`balanced` 從第一秒就是 1080p）；sender `degradationPreference: 'balanced'`（壓力下解析度與幀率一起降，不再只掉幀）、`priority`／`networkPriority: 'high'`（同一條 PeerConnection 的頻寬估計依優先權分配，分享拿大份）、`maxBitrate` 2.5 Mbps、`maxFramerate` 30。文字／動態模式切換仍是 M1 `e3-t06`。
- **鏡頭**：`maxBitrate` 800 kbps、`maxFramerate` 30（沒有 simulcast 前每個接收端都收整條，8 人時每人收 7 條；也讓分享在同一條上行有空間）；degradation 用瀏覽器預設（鏡頭本來就是 `balanced`）。
- **起始頻寬**：發布時把 SFU answer 裡 VP8 的 fmtp 加上 `x-google-start-bitrate=1000`（kbps）再 `setRemoteDescription`。**只改本機**：SFU 看不到這個改動（這是瀏覽器 sender 從 remote description 讀的設定），Realtime 的 session 狀態不變；之後頻寬照 SFU 的 transport-cc 回饋調整，只是起點從 Chrome 預設的 300 kbps 改成 1,000 kbps。預期 Chrome 只在這個值改變時重設估計（libwebrtc 的 bitrate 設定比對），所以之後的發布（例如分享）不會把估計拉回 1,000；這點沒有單獨驗證，量到的分享數字已經包含它。非 Chromium 瀏覽器忽略它。上行真的很差的人頭一兩秒可能多掉一點包，之後估計會降下來。
- 只送 VP8、不做 simulcast（`e2-t11`／H1 再改成每層的 encodings）。

## 後果

- **要自己做的**：房間與軌清單（RoomDO，A3／B1）、desired／actual 訂閱對齊（`e2-t04`）、重連（`e2-t08`）、選層策略（`e2-t12`、`e2-t15`）、統計（`e2-t13`）。這些 LiveKit SDK 會送，Realtime 不會；已經排進 E2 的 task。
- **Worker 代理是信任邊界**：A2 的 `/api/sfu/*` 還沒綁房間成員。**B1（`e2-t03`）已綁定**：路徑帶房間 id，RoomDO 的 `sfuAccess` 只接受該房成員的 session token（不然 401）；建立 session 後 `bindSfu` 把它記成該成員的（同一成員再建一個就取代舊的，舊 session 的軌清單清掉），之後對這個 session 的呼叫只接受它的主人（不然 403）；pull 的每條軌都必須是同房成員正在發布的（不然 404 `track_not_in_room`）。push 的軌種類從 offer 的 m-line 讀出，給免費額度保護用（`DEPLOY.md` §6）。
- **兩個 secret**：`REALTIME_APP_ID`、`REALTIME_APP_SECRET`（`DEPLOY.md` §5）；TURN 另外兩個：`REALTIME_TURN_KEY_ID`、`REALTIME_TURN_KEY_API_TOKEN`（`e2-t07`，B3）。
- **元件不碰 WebRTC**（規則 2）：會議室頁只透過 `src/room/RoomMedia.ts`（發布、desired／actual 訂閱對齊）與 `MediaTransport`；A2 的 `/dev/realtime` spike 在 B1 移除。

## 切換條件（何時改用 LiveKit）

下列任一成立就啟動 `e2-t17`（`LiveKitTransport`），介面不變、批次不變：

1. 兩台不同裝置（不同網路）的 spike 無法穩定互通，或 Safari／iOS 有無法繞過的問題。
2. Realtime 的免費額度或價格改變，使 4 人 2 小時一場的成本高於 LiveKit Cloud。
3. 8 人格狀實測時下行無法壓到 4 Mbps 以內（simulcast 選層不可用）。

## 驗證

- 已驗證（A2）：Worker 代理的路徑、標頭、錯誤處理（`tests/worker/sfu.test.ts`，mock fetch）；`CloudflareRealtimeTransport` 的呼叫順序與 body 和官方 connection patterns 一致（`tests/app/media/CloudflareRealtimeTransport.test.ts`，mock PeerConnection）；`FakeTransport` 行為（`tests/app/media/FakeTransport.test.ts`）；本機 `vite dev` 下 `/api/sfu/sessions` 未設定 secret 時回 503。
- 已驗證（B1）：代理的成員綁定與拒絕路徑（`tests/worker/sfu.test.ts`，背後是真的 `RoomHost`）；`RoomMedia` 的發布與 desired／actual 對齊（`tests/app/RoomMedia.test.ts`、`tests/app/RoomMediaPage.test.tsx`，`FakeTransport`，含 StrictMode）。PR 預覽上的結果寫在 #8。
- **尚未驗證**：兩台不同裝置透過 Cloudflare 互通。用會議室頁在兩台不同裝置實測（步驟見 `DEPLOY.md` §5）。實測通過前 AC-2.2 不勾。
