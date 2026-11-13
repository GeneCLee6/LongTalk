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
- **simulcast**：發布端 `sendEncodings` 用 rid `f`／`h`／`q`（1、½、¼ 解析度）；接收端 `preferredRid` 搭配 `ridNotAvailable: 'asciibetical'`（H1 起 `priorityOrdering: 'none'`），字母越前面越優先，所以 `f` 是最高層。`Layer` 對應：`high→f`、`medium→h`、`low→q`。H1 實作與實測見下面「Simulcast」。
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
  setTopLayer(trackName: string, top: 'high' | 'medium' | 'low'): Promise<void> // H3: HD
  setShareMode(trackName: string, mode: 'text' | 'motion'): Promise<void> // H5: 文字／動態
  getUplink(trackName: string): Promise<UplinkStats> // H3: availableOutgoingBitrate, limitation
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
- **H3 加上 `setTopLayer` 與 `getUplink`**（`e6-t04`）：`setTopLayer` 用 `RTCRtpSender.setParameters` 開關已發布視訊的 simulcast 層（`medium`＝`f` 層 `active: false`，最低層一定留著；單層 sender 改成縮一半），不需要 SDP 交換，`replaceTrack` 之後照樣有效、重新發布時回到全開，由 `RoomMedia` 再套一次。`getUplink` 讀那條軌 sender 的 `outbound-rtp` `qualityLimitationReason`（送出中的層裡最差的）與選定 candidate-pair 的 `availableOutgoingBitrate`，給 HD 的上行檢查（`src/media/uplink.ts`）。H2 的 `getStats` 擴充若也帶這兩個值，可以合併成一個。
- **H5 加上 `setShareMode`**（`e3-t06`）：已發布的分享換成文字或動態模式：軌的 `contentHint`、sender 的 `degradationPreference` 與每層的 `maxFramerate`／`maxBitrate`／`scaleResolutionDownBy`（`src/media/shareMode.ts`），一次 `setParameters`，不需要 SDP 交換；`setTopLayer` 的 `active` 照留。`replaceTrack` 換了來源（換一個畫面）之後新軌沒有 `contentHint`，`RoomMedia` 再呼叫一次。
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
- 只送 VP8。H1 起鏡頭與分享改成 simulcast 的每層 encodings（下一節）；上面的單層參數留給拒絕 simulcast 的瀏覽器。

## Simulcast（H1，2026-11-03，`e2-t11`、`e2-t12`，#29）

### Realtime 怎麼做（官方文件〈Simulcast〉與 OpenAPI `realtime-api-2024-05-21`，加上 PR 預覽實測）

- **發布**：沒有新端點。transceiver `sendonly`、`sendEncodings` 每層一個 `rid` ＋ `scaleResolutionDownBy`，offer 帶 `a=simulcast:send f;h;q` 與每層的 `a=rid:<id> send`；照常 `tracks/new`（`location: 'local'`、`mid`、`trackName`），answer 回 `a=simulcast:recv f;h;q`。一條 m-section、一組 payload type，所以 #13 的 payload type 問題不會因 simulcast 回來（只送 VP8 照舊）；起始頻寬改寫只碰 VP8 的 fmtp，simulcast 那幾行原封不動，照樣有效（測試與實測都確認）。
- **訂閱**：`tracks/new` 的 remote 軌可以帶 `simulcast: { preferredRid, priorityOrdering, ridNotAvailable }`。`priorityOrdering`：`none`＝頻寬不夠也照送 preferredRid；`asciibetical`＝頻寬不夠時依 a–z 的優先順序降（a 最想要，所以 `f` > `h` > `q`）。`ridNotAvailable`：`none`＝發布者沒送那層就不換；`asciibetical`＝換成排序後下一個有的層。**兩個預設都是 `none`**。我們用 `priorityOrdering: 'none'`、`ridNotAvailable: 'asciibetical'`，每次都明寫（為什麼見下面「實測」）。
- **換層**：`PUT …/sessions/{接收端 session}/tracks/update`，body `{ tracks: [{ location: 'remote', mid: 接收端的 mid, sessionId, trackName, simulcast: {...} }] }`，不帶 SDP。實測回 `200 { requiresImmediateRenegotiation: false, tracks: [{ mid }] }`；它仍是 session 的一次變更，所以走同一個佇列（一次一個），回應若要重新協商就先回答（`setPreferredLayer`）。
- **沒有暫停**：API 沒有 `enabled`／`pause` 之類的欄位；要停收只能關掉那條軌（雙方各重新協商一次）。H1 時看不見的格子是「最低層」，不是暫停；L1（`e2-t18`）起真的退訂，見「只訂閱看得到的人」。
- 文件沒寫：支援哪些 codec、最多幾層、SFU 自己的頻寬估計怎麼算與何時換層。實測看到的行為記在下面。

### 發布（`src/media/encoding.ts` `SIMULCAST`）

**Chrome 依來源大小決定送幾層**（libwebrtc 的 simulcast 層數上限）：本機兩個 PeerConnection 對送、假鏡頭，640×480 的來源只送 `f`、`h`，`q` 一直是 0 bytes；1280×720 的來源三層都送。所以鏡頭改成要 **1280×720**（`devices.ts` `CAMERA_CAPTURE`，`ideal`，做不到的鏡頭照它能的開），也剛好是格子的 16:9。

| | rid | 縮小 | 最高位元率 | 最高 fps | 短邊（給選層比較） |
| --- | --- | --- | --- | --- | --- |
| 鏡頭 | `f` | 1 | 1.2 Mbps | 30 | 720 |
| | `h` | 2 | 400 kbps | 30 | 360 |
| | `q` | 4 | 120 kbps | 15 | 180 |
| 分享 | `f` | 1 | 2.5 Mbps | 30 | 1080 |
| | `h` | 2 | 600 kbps | 15 | 540 |

- 位元率參考 libwebrtc 自己的 simulcast 階梯，最高層略低於它的 720p 2.5 Mbps（只有大格會要 `f`）。分享的優先權 `high`、`balanced` degradation 照舊（套在整個 sender）。
- 瀏覽器拒絕 simulcast 的 `sendEncodings`（`addTransceiver` 丟錯）時改送一層（上面的單層參數）；訂閱端的 `ridNotAvailable: 'asciibetical'` 會落到那一層。
- 本月超過低畫質門檻時鏡頭照舊降到 320×180：照上面的層數規則 Chrome 只會送一層 `f`（預期，沒有單獨量），訂閱端經 `ridNotAvailable` 落到它。
- 上行：鏡頭三層合計最多約 1.7 Mbps（原本 800 kbps），分享再加 3.1 Mbps；上行不夠時 Chrome 先停最高層。

### 選層（`src/media/layers.ts`、`src/room/videoDemand.ts`、`src/components/useVideoDemand.ts`）

- 每個顯示別人視訊的 `<video>`（`Tile`、`ShareTile`）用 ResizeObserver 回報畫出的大小（CSS 像素 × `devicePixelRatio`，最多 2 倍）、IntersectionObserver 回報是否在畫面上（翻走的頁、捲出去的條帶都被捲動容器裁掉）、畫面的寬高比；分頁在背景（`visibilitychange`）時全部算看不見。報到 `VideoDemandStore`，以 MediaStreamTrack 為 key，同一條軌在兩處就取最大的那個看得見的。元件不碰 WebRTC（規則 2）：選層在 `RoomMedia`，經 `MediaTransport.setPreferredLayer`。
- **大小**：鏡頭是 `cover`、分享是 `contain`，算出畫面上實際用到的來源短邊；要「短邊 ≥ 它的 80%」的最小一層。看不見、沒有格子（只顯示首字、隱藏）就最低層（分享沒有低層：`h`）。
- **遲滯**：已經在的層，只要還「夠用」（80%）就不往上換；往下換要下一層能「完全蓋住」（100%）。所以 360 行的層在 360–450 行之間不會來回跳。另外 `RoomMedia` 在版面變動後等 400 ms 才重算（捲動、動畫、拉視窗是一串事件），只送有變的層。
- **預算**：每人視訊下行 3.4 Mbps（AC-2.6 的 4 Mbps 扣掉聲音與封包負擔），用各層的最高位元率計算；超過就一次降一步，每步給「降了之後損失最少畫面細節」的那格（面積 × 失去的覆蓋比例）：小格先讓、一樣大的輪流；鏡頭都到最低了才動分享。往上換要留 15% 的餘裕。
- **起始層**：拉軌時就帶偏好（鏡頭 `h`、分享 `f`），格子回報後再調；不用等一次 `tracks/update`。
- **不用瀏覽器的 `availableIncomingBitrate`**：第一次預覽實測時把它當上限，Alice 的估計是 398 kbps、實際正收 362 kbps，所有層都被壓在 `q` 且回不來：在 Realtime 的下行它跟著已收到的量走，不是可用的頻寬。SFU 自己的估計也不用（`priorityOrdering: 'none'`，見「實測」）。所以**頻寬比預算少的連線目前不會自動降層**，會丟包、卡頓；依丟包、凍結降低預算是 H2 的 `e2-t15`。

### 實測（PR 預覽，同一台電腦一個 headless Chrome 裡的 N 個成員，假鏡頭 1280×720）

量法：`candidate-pair.bytesReceived` 10 秒的差＝每人下行；`inbound-rtp.frameHeight` 看收到哪一層（720＝`f`、360＝`h`、180＝`q`）；`outbound-rtp` 每個 rid 的解析度與位元率；記下每個 `tracks/update` 與回應。視窗 1280×800，8 人時格子 381×214。**所有成員在同一台機器**（8 個 720p 三層編碼＋各 7 路解碼），fps 受 CPU 限制（約 20），所以看位元率與層，不看 fps。

| 8 人格狀（視窗 1280×800，格子 381×214） | 改之前（main，正式站，單層 640×480） | 改之後（#29） |
| --- | --- | --- |
| 每人下行 | **3.28–3.30 Mbps**（8 人都一樣） | **2.51–2.54 Mbps** |
| Alice 收到的 7 個格子 | 全部 640×480、每條約 425 kbps | 全部 640×360（`h`）、每條 308–326 kbps，沒有任何 `tracks/update`（起始層就對） |
| 釘選 Bot1（大格 986×554、條帶 172×96） | 大格與條帶都是 640×480、約 425 kbps，Alice 3.30 Mbps | 大格 **1280×720（`f`）668 kbps**、條帶 6 格都 **320×180（`q`）約 120 kbps**，Alice **1.85 Mbps**；7 個 `tracks/update` 都 200 |
| 發布端（Bot1） | 一層 640×480 約 425 kbps | `f` 1280×720 約 660–700 kbps、`h` 640×360 約 310–330 kbps、`q` 320×180 約 118 kbps；上行約 1.6 Mbps |

- 假鏡頭的畫面很好壓：改之前每條只有 425 kbps（上限 800 kbps）。真的鏡頭接近上限時，改之前 8 人格狀每人約 5.6 Mbps＋聲音，**超過 AC-2.6 的 4 Mbps**；改之後格狀每條 `h` 上限 400 kbps，7 條 2.8 Mbps＋聲音，加上預算上限 3.4 Mbps，都在 4 Mbps 以內。
- **手機直拿**（6 人，最後一位是 390×844、3 倍像素的手機）：第 1 頁 4 格（183×183，算 2 倍＝366 px）都收 `h`，第 2 頁看不到的那格收 `q`（116 kbps）。手機下行 1.69 Mbps。
- **時間序列（每 3 秒看一次 Alice 收到哪一層）**：4 人時，釘選後大格約 3 秒到 `f`、條帶約 10 秒到 `q`；剛拉的軌前幾秒偶爾是別層（發布者的那一層還沒開始送，`ridNotAvailable` 先給別的），約 10 秒內回到要的層。
- **`priorityOrdering` 比較**（8 人，同一台機器）：`asciibetical` 時 SFU 自己的估計讓格狀的格子在 `f`／`h`／`q` 之間跳（381 px 的格子收到 720p），釘選的大格 35 秒都只在 `h`／`q`，下行 1.3–2.9 Mbps 起伏；`none` 時格狀穩定在 `h`、大格 3 秒到 `f`、條帶約 6 秒到 `q`。所以用 `none`：選層自己守預算，SFU 照要的送。代價是**頻寬比預算少時不會自動降**（H2）。
- 起始頻寬改寫在 simulcast 下仍有效：發布後 `f` 從一開始就是 1280×720。三人 e2e（CI）與所有 8 人實測都沒有 payload type 錯誤或 406。
- 原始數字：本機 scratchpad `multi/results/h1-*.json`（不進 repo）。

### 沒有驗證的

- 兩台不同的真實裝置（AC-2.6 要求；`DEPLOY.md` §5 第 20 步）。真鏡頭的畫面比假鏡頭難壓，同一層的位元率會比上面高，接近各層上限。
- Safari 與 Firefox 的 simulcast 發布（rid 順序、層數）；Safari 拒絕時的退回一層只有單元測試。
- 真正頻寬不足時的情況：`priorityOrdering: 'none'` 下 SFU 照送要的層，接收端會丟包；`asciibetical` 時看到的降層來自同一台機器的 CPU 負載，不是網路。H2 依丟包降低預算（下面「統計與頻寬自適應」），真的網路還沒量。

## 統計與頻寬自適應（H2，2026-11-03，`e2-t13`、`e2-t14`、`e2-t15`，#31）

### 一條統計路徑

- `MediaTransport.getStats()` 讀一次 PeerConnection 的 `getStats()`，`src/media/stats.ts` `readStatsReport` 依 transceiver 的 mid 認出每條送出的軌（每個 rid 一層：解析度、幀率、`active`、`qualityLimitationReason`，加上 SFU 回報的 `remote-inbound-rtp` 丟包）與每條訂閱（位元率、丟包、jitter、解析度、幀率、`framesDropped`、`freezeCount`、jitter buffer、音訊隱藏樣本），選定的 candidate pair 給 RTT、直連或 TURN、候選類型與協定、`availableOutgoingBitrate`。不帶 SDP、token。`sampleStats` 用兩次讀數算這 2 秒的量（計數器倒退＝新的訂閱，當第一次）。
- `RoomMedia` **每 2 秒讀一次**（`STATS_POLL_MS`），這是唯一的讀取：免費額度的 `stats`（每 10 秒）、名牌訊號格、統計面板（`StatsStore`，只有開著的面板訂閱，不讓整個會議室頁每 2 秒重繪）、自適應、H3 的 HD 上行檢查（原本的 `getUplink` 併進來，讀最新一份樣本）都用它。PR 預覽實測一次 `getStats()` 中位數 0.9 ms、p95 3 ms（4 人，Alice 收 3 鏡頭＋3 麥克風）。
- **訊號格**：`src/media/quality.ts` 每份樣本判好／普通／差（下行、上行、RTT 取最差），名牌用最近三份裡第二差的（一次尖峰不會閃「差」）。別人看到的是對方自己判的：協定 v14 `signal`，變了才送、最多每 5 秒，RoomDO 存在 `Member.signal`（每人每 10 秒最多 3 次，多的直接丟；重新連線期間保留）。

### 判斷

- **下行「差」一定要有丟包**：影片或聲音這 2 秒丟包 ≥ 5 %（至少 50 個封包才算）就是差；隱藏音 ≥ 8 %、jitter buffer ≥ 400 ms、凍結 ≥ 600 ms 也要同時有 ≥ 1 % 丟包才算差，沒有就最多「普通」。理由：第一版在 CI（兩核心的 runner 上三個瀏覽器）把所有人的視訊停掉了：CPU 不夠時隱藏音、jitter buffer、凍結都會出現，卻一個封包都沒丟；降低接收對那種情況沒有幫助。凍結與幀率太低（< 層的一半）也可能是發布端的問題，同樣要有丟包才算。RTT 只影響訊號格，不觸發自適應。
- **上行**：編碼器 `qualityLimitationReason` 是 `bandwidth`，或 SFU 回報丟包（影片 ≥ 10 %、聲音 ≥ 5 %）＝壓力；`cpu` 也是壓力，但**只會關鏡頭的 `f`**（720p 的編碼才貴；CI 上 CPU 受限好幾分鐘，再往下會把所有人壓到 180p）。

### 下行：降層 → 停收 → 建議純音訊（`src/media/adaptation.ts` `DownlinkAdaptation`）

1. 連續 2 次差：視訊預算（原本 3.4 Mbps，H1 的選層在預算內選）降到目前要求量的 60 %，不低於全部最低層的總和。小格先降（`chooseLayers`）。
2. 全部已經最低層還差：**停收**釘選／聚光燈以外、大格與講話者以外的鏡頭（最多留 2 個），格子顯示首字、名牌說「視訊已暫停（網路不佳）」；分享畫面與所有聲音照收。Realtime 沒有暫停，所以是退訂，之後再訂閱。講話者每幾秒就換，第一版實測**每 3 秒退訂又訂閱一次**（兩邊各一次重新協商）：現在被留下的鏡頭在最後一次被列入後保留 15 秒，只有釘選／聚光燈能立刻搶位置。
3. 還是差：提示條「網路不佳…切換成純音訊」，按了是 H3 的純音訊模式（`RoomMedia.setAudioOnly`；離開純音訊時自適應從頭開始）。不會自動切。
- 每一步之後等 2 次（統計落後於變化）；連續 5 次好就往上一段（預算 ×1.6＋200 kbps），「普通」原地不動；升上去 20 秒內又差，下一次要等兩倍（最多 60 秒），在正常狀態 60 秒沒事就恢復 10 秒。

### 上行：關最高層（`UplinkAdaptation`）

- 壓力連續 5 次（10 秒）：鏡頭的 `f` 關掉（H3 的 `MediaTransport.setTopLayer`，和 HD 取兩者較低的），再 10 秒：分享的 `f`，再 10 秒：鏡頭的 `h`。連續 15 次（30 秒）都正常就一層層開回；開回 20 秒內又有壓力，下一次等兩倍（最多 2 分鐘）。**開回不看 `availableOutgoingBitrate`**：層關掉之後瀏覽器只探測到它在送的量，估計永遠不會顯示「夠」（實測 `f` 從此不回來；H3 對 HD 也發現同一件事）。

### 實測（PR 預覽 #31，同一台電腦一個 headless Chrome 裡 4 人，假鏡頭 1280×720）

**WebRTC 的流量在這裡沒辦法真的限速**：CDP 的 `Network.emulateNetworkConditions` 只管 HTTP，不管 WebRTC；Chrome 沒有可用的 WebRTC 限速 field trial；Windows 沒有 `tc`（clumsy／WinDivert 要系統管理員）。所以**改的是 app 讀到的數字**：init script 包住 `RTCPeerConnection.prototype.getStats`，在 Alice 的 `inbound-rtp` 加上 8 % 的 `packetsLost`、在 Bot1 的 `outbound-rtp` 填 `qualityLimitationReason: 'bandwidth'`；app 因此做的事（`tracks/update`、退訂、重新訂閱、`setParameters`）都打到真的 SFU 與真的 sender，再用沒包過的 `getStats()` 量實際的流量。量到的是控制路徑與時間，不是門檻對真實壅塞準不準。

| 事件（Alice，3 人的鏡頭都在格狀） | 時間 |
| --- | --- |
| 丟包開始 → 「已降低畫質」（預算 720 kbps） | 4 秒 |
| → 預算 384 kbps（全部 `q`，下行 1.14 → 0.56 Mbps） | 8 秒 |
| → 停收 1 人的鏡頭（下行 ≈ 0.40 Mbps；留下 2 個） | 16 秒 |
| → 建議純音訊的提示條 | 20 秒 |
| 丟包期間的訂閱變動 | 停收 1 次；講話者換人 15 秒後換 1 次（第一版是每 3 秒一次） |
| 丟包停止 → 回到停收 → 恢復收全部鏡頭 → 正常（3.4 Mbps） | 10 秒 → 22 秒 → 62 秒 |
| Bot1 上行受限 → 鏡頭 `f` 關（`active: false`，0 kbps） | 10 秒（再 10 秒關 `h`，只剩 `q`） |
| 受限結束 → `h` 開回 | 28 秒（`f` 再 30 秒；修正前因為等估計，從此不回來） |

- 全程聲音不斷，沒有重建 session；CI 的三人 e2e（含 Carol 釘選後大格比條帶高）在 CPU 吃緊的 runner 上照常通過。
- 原始數字：本機 scratchpad `multi/results/h2-*.json`（不進 repo）。

### 沒有驗證的

- **真的網路變差**（AC-2.7 要求兩台不同裝置）：門檻（5 % 丟包、10 秒、30 秒…）是依常見值訂的，`DEPLOY.md` §5 第 22 步用 Network Link Conditioner／clumsy 實測後再調。
- Safari、Firefox 的統計欄位（`qualityLimitationReason`、`freezeCount`、`mid`、`active` 有的沒有）：沒有就當不知道，不會誤判成差，但也少了訊號。
- 頻寬一直很低（例如 300 kbps）時下行會停在「建議純音訊」；音訊本身的頻寬（約 32–64 kbps × 人數）不在自適應裡。

## 進階噪音抑制與省電模式（H4，2026-11-03，`e6-t02`、`e6-t05`，#33）

### 進階噪音抑制：RNNoise 在 AudioWorklet 裡

- **送出的路徑**：麥克風的軌 → `AudioContext`（`sampleRate: 48000`、`latencyHint: 'interactive'`）→ `AudioWorkletNode`（`longtalk-rnnoise`，單聲道）→ `MediaStreamAudioDestinationNode` 的軌 → `RoomMedia.setLocal({ mic })` → `MediaTransport.replaceTrack`（同一條已發布的麥克風軌，**不重新協商**；規則 2 不變：管線不碰 PeerConnection）。關掉就把麥克風本身換回去。房間頁在 `AudioContext` 沒在跑的時候（沒有使用者手勢、Safari 來電）照送麥克風本身。
- **wasm**：xiph/rnnoise（BSD-3-Clause），shiguredo/rnnoise-wasm 編的兩個檔（一般 153 kB、SIMD 157 kB；gzip 約 114 kB），取自 `@sapphi-red/web-noise-suppressor` 0.4.1（MIT）。不用 emscripten glue：模組只 import `emscripten_memcpy_big`、`emscripten_resize_heap`、`__assert_fail`，由 `src/media/rnnoiseCore.ts` 提供，worklet 因此只有一個 3 kB 的檔。頁面 `fetch` wasm（自己的 `/assets/`），用 `processorOptions` 交給 worklet，worklet 自己 `WebAssembly.instantiate`。有 SIMD 就拿 SIMD 版。授權：`THIRD_PARTY_NOTICES.md`（建置時也放 `/third-party-notices.txt`）。
- **分幀與延遲**：RNNoise 一幀 480 樣本；render quantum 128。輸出延遲 448 樣本（9.3 ms）是不會斷音的最小值（15 個 quantum 一循環，128·k mod 480 最大 448）；context 的 `baseLatency` 在 headless Chromium（Windows）是 10 ms，合計約 19 ms。樣本乘 32768（RNNoise 用 16-bit 的刻度）再除回來。
- **CPU**：worklet 每 100 幀（1 秒）回報處理時間占比與最慢一幀；連續 5 秒 > 35 % 或有一幀 > 2.4 ms 就關掉並提示（`src/media/noiseLoad.ts`）。Node（同一台 Windows 筆電）一幀 0.13 ms／SIMD 0.09 ms；headless Chromium 的 worklet 裡 0.1–0.9 %。Chromium 的 `AudioWorkletGlobalScope` 沒有 `performance`，用 `Date.now()`（1 ms 解析度，加總仍不偏）。
- **瀏覽器的噪音抑制**：進階的開著時關掉（`noiseSuppression: false`，Chrome 改不了就重開麥克風，管線換輸入、送出的軌不變），避免兩次處理；回音消除、自動增益照常。
- **不需要** `SharedArrayBuffer`／cross-origin isolation：wasm 只在 worklet 的執行緒裡，主執行緒與 worklet 之間只傳一次 wasm 的 bytes 和每秒一則負載。

### 省電模式

- `RoomMedia.setPowerSaving`：選層預算 0（`POWER_SAVING_BUDGET_BPS`，`chooseLayers` 把每條都降到最低層：鏡頭 `q` 180p 15 fps、分享 `h` 一半大小 15 fps）；鏡頭的最高層 `medium`（和 HD、上行自適應取最低）；鏡頭擷取 `frameRate: { max: 15 }`（新的鏡頭開始送時也套用；關掉時拿掉，本月低畫質時保留）。自適應照常在底下跑。
- 頁面：動畫關（`MotionOffContext`＋`html[data-motion='off']`）、進階噪音抑制暫停；Battery Status API（Chromium）電量 ≤ 20 % 且沒充電時提示一次，不自動開。
- 統計面板的「模式」一段顯示 HD、省電、純音訊、進階噪音抑制（負載與延遲），AC-6.4 的「統計面板反映變化」。

### 驗證與沒有驗證的

- 已驗證：分幀、延遲、wasm 在 Node 裡真的壓低白雜訊而保留穩定的音（`tests/app/media/rnnoise.test.ts`）；管線接線、失敗與暫停（假的 Web Audio，`tests/app/h4.test.tsx`）；房間頁送出的軌、瀏覽器噪音抑制暫停、CPU 超標自動關、省電模式擋住它（`tests/app/h4Room.test.tsx`）；省電模式的選層、HD、幀率（`FakeTransport`）；headless Chromium 裡 worklet 與 wasm 從自己的 `/assets/` lazy 載入並在跑（`e2e/local/noise.spec.ts`，CI 的 `UI checks`）；經真的 SFU 打開後對方仍聽得到（`e2e/interop.spec.ts`，PR 預覽）。
- **沒有驗證的**：鍵盤、風扇聲在接收端是否明顯降低（AC-6.2 要兩台裝置錄音比對，`DEPLOY.md` §5 第 23 步）；低階筆電與手機上的實際 CPU 與門檻是否合適；Safari／Firefox 上 worklet 是否正常（Firefox 麥克風非 48 kHz 時預期會失敗並提示）；省電模式的實際省電量。

## 分享模式與多人分享（H5，2026-11-03，`e3-t06`–`e3-t09`，#34）

### 文字／動態（`src/media/shareMode.ts`）

| | 文字（預設） | 動態 |
| --- | --- | --- |
| `contentHint` | `detail` | `motion` |
| `degradationPreference` | `balanced`（D1 #21 的實測值：`maintain-resolution` 一有壓力就掉到 1–2 fps） | `maintain-framerate` |
| `f` 層 | 擷取原尺寸（最高 1080p）、30 fps、2.5 Mbps | 最高 720p（`scaleResolutionDownBy` 依擷取的短邊算，不放大）、30 fps、2.5 Mbps |
| `h` 層 | 一半、15 fps、600 kbps | 最高 360p、30 fps、600 kbps |

- 擷取的約束兩種模式一樣（最高 1920×1080、30 fps）：切換只動編碼器，不重新擷取、不重新選畫面、不重新協商（`MediaTransport.setShareMode`）。
- 模式在分享者的瀏覽器記到離開房間為止（下一次分享沿用），不送給 RoomDO。

**本機量測**（2026-11-03，headless Chromium 同一頁兩條 RTCPeerConnection、VP8 單層、替身 1920×1080 canvas 30 fps、`maxBitrate` 當頻寬上限、熱身 12 秒後量 4 秒的 `outbound-rtp`；loopback 的頻寬估計從低處爬升，數字是相對比較，不是 Realtime 上的值）：

| 內容 | 上限 | 文字：fps／解析度／QP | 動態：fps／解析度／QP |
| --- | --- | --- | --- |
| 影片般的畫面（漸層＋移動的圓） | 2.5 Mbps | 30／1920×1080／41 | 30／1280×720／**11** |
| 同上 | 1 Mbps | 23／1920×1080／106（糊、方塊） | **30**／853×480／26 |
| 整頁捲動的密集文字＋方塊（極端） | 1 Mbps | 10.5／1920×1080 | 30／320×180 |
| 同上 | 500 kbps | 3.8／1920×1080 | 22.5／320×180 |
| 靜止的文件（每秒一個游標閃爍） | 2.5 Mbps | 30／1920×1080，**73 kbps** | 30／1280×720，**1,314 kbps** |

結論：文字模式守住解析度、壓力下降幀率，影片在 1 Mbps 只剩 23 fps 而且很糊；動態模式守住 30 fps、降解析度，同樣頻寬下畫質好得多（QP 低）。但**動態模式在靜止內容上多花十幾倍頻寬**（`motion` 關掉了 screencast 的靜止畫面最佳化），所以預設文字、只在內容持續在動時提示，不自動切換。

### 動態內容提示

- 分享時每秒從本機擷取一張 160 px 寬的小圖（`src/room/shareSampler.ts`：Chromium 用 `ImageCapture.grabFrame()`，分頁在背景也拿得到；其他瀏覽器用靜音的 `<video>`＋`requestVideoFrameCallback`），同一張也是簡報者檢視的縮圖。
- 亮度變化超過 24（0–255）的像素超過 4% 算「這一秒在動」；最近 8 秒裡 6 秒在動就提示（`MotionMeter`）。打字、游標、換一張投影片不會觸發；捲動文件只動一兩秒。每個畫面只提示一次（按「不用」、切到動態、或平靜下來都算回答；換一個畫面後可以再提示）。
- 沒有用 `outbound-rtp` 的統計判斷：Chrome 的螢幕擷取只在畫面變化時送幀，但幀率與 `qualityLimitationReason` 在頻寬受限時也會變，分不出「內容在動」與「網路不好」。

### 多人同時分享（協定 v15）

- `RoomInfo.shares`（以成員 id 為 key），最多 `MAX_SHARES` = 3 人；第四人回 `share_full`（誰的分享都不會被搶走）。權限表的 `shareScreen`、`stopShare` 不變；主持人、共同主持人可以停止任何一個分享，其他分享照常。v14 存的 `share` 讀成只有一筆的 `shares`。
- 誰在主區是每個觀看者自己決定（`shared/layout.ts` `shareSlots`）：選過的人還在分享就是他，否則最新的分享；自己的分享永遠不在主區。其他分享排在側列最前面，點一下換到主區；兩個以上時主區右上有選擇鈕。選擇記在這個分頁的 sessionStorage。
- **選層**：主區的分享畫得大，照 H1 的大小規則要 `f`；側列的小格要 `h`。預算（3.4 Mbps，依各層上限加總）在多個分享時常常「超過」：主區 `f` 2.5 Mbps＋側列 `h` 600 kbps×2＋4 個鏡頭的 `q` 就是 4.2 Mbps，照原本的規則會把主區降到 `h`（540p，文件讀不清楚）。H5 起**主區的分享（畫得最大的那個）在完整預算下不降層**：分享很少接近上限（靜止的畫面幾乎不花頻寬），而且那是觀看者正在看的；H2 因為丟包、卡頓降低預算之後才照常降。最壞情況（3 個分享、上限全滿）超過 AC-2.6 的 4 Mbps，那條 AC 是 8 人格狀、沒有分享。
- **分享其實一直只送一層（H1 起的 bug，H5 的 e2e 抓到）**：`simulcastEncodings` 在每一層都帶 `priority`／`networkPriority: 'high'`，Chrome 對第一層以外的非預設優先權丟 `OperationError`（unimplemented parameter），`addTransceiver` 失敗後退回單層，所以每個接收端都收到整條 `f`、要 `h` 也沒有（鏡頭的 `low` 是預設值，所以沒事）。修正：優先權只放在第一層（Chrome 本來就從第一層讀整個 sender 的優先權），分享照樣拿上行的大份。本機 headless Chromium 驗證：兩層＋第一層 `high` 可以建立，之後 `balanced`／`maintain-framerate` 的 `setParameters` 也都接受。
- **分享的實際大小**：H1 用名目短邊（`f` 1080、`h` 540）選層，但分享的視窗、分頁常常比 1080p 小：720p 的來源 `h` 只有 360 行，960 × 540 的主區照名目值會選 `h`、放大 1.5 倍變糊（PR 預覽 e2e 抓到的：主區與側列都收到 `h`）。H5 起畫面一到，就用收到的畫面短邊 × 目前那層的縮放倍數算出來源的實際短邊，各層的短邊照它換算（`layers.ts` `layerSides`，`VideoDemand.sourceShortSide`）；只用在分享，鏡頭的擷取大小是固定的。
- 上行：每個分享者只送自己的一個分享，跟 H1 一樣。

### 防鏡像遞迴（`src/media/share.ts` `selfCapture`）

- 選擇器：`selfBrowserSurface: 'exclude'`（Chromium 不列出這個分頁）、`surfaceSwitching: 'include'`（分享中可以換分頁），D1 起就有。
- 偵測三種：**別的會議分頁**（每個 LongTalk 分頁用 Capture Handle 宣告 `longtalk:<房號>`，只讓本站讀；分享的分頁帶這個 handle 就是）；**會議所在的視窗**（Firefox 的視窗軌 label 是視窗標題，含這頁的標題就是；Chrome 的 label 是 `window:…`，認不出來）；**整個螢幕**（`displaySurface: 'monitor'`，而且會議頁可見又有焦點連續 3 秒：大家看到的是會議室本身）。提醒在提示條下面，「換一個畫面」重新打開選擇器，選好後用同一條已發布的軌換來源（`replaceTrack`，大家的訂閱不變，分享不中斷）；「知道了」對這個畫面不再提醒。
- 分享整個螢幕或偵測到會議本身時，簡報者縮圖不顯示（避免縮圖裡又有縮圖），改寫一行原因。

### 沒有驗證的

- 都還沒在 Realtime 上量：文字／動態在真實網路的差別、三個分享時每人的下行、動態內容提示在真的影片與投影片上會不會誤判（門檻在 `shareMode.ts`）。PR 預覽的 e2e 只確認兩人同時分享、主區 `f` 比側列 `h` 高、主持人停一個、切動態後畫面照常。
- Capture Handle 只有 Chromium；Safari、Firefox 分享別的會議分頁時認不出來。

## WebKit 同時送鏡頭與分享（2026-11-06，#42）

`Preview / e2e-firefox` 的 `Chris (chromium) decodes Wes's screen` 從 H6 起常常第一次失敗、重跑才過（#42 之前 10 次 job 裡第一次就過的只有 3 次；另有 1 次失敗是別的原因）。在 PR 預覽上加了暫時的記錄（每個 mid、每個 rid 的統計，格子的平均顏色），重複跑 Playwright 的 Linux WebKit ＋ Chromium，都不重試：

| 條件（WebKit 分享時） | 看不到分享的次數 |
| --- | --- |
| 照常 | 1／4 |
| 不要 `q`（把鏡頭的 `tracks/update` 改回 `h`） | 4／5 |
| 照常（第二輪） | 1／3 |
| 第二個 `getUserMedia` 代替 canvas 當畫面 | 1／4 |
| 分享只送一層 | 1／4 |
| 鏡頭、分享都只送一層 | 2／4 |
| 照常（第三輪） | 4／7 |
| **WebKit 的鏡頭先關掉** | **0／7** |

鏡頭開著合計 14／31。關掉與開著的差別在這個樣本量下算顯著（超幾何機率約 0.03），但只有 7 次。

**看到的現象，每次看不到分享時都一樣：**

- **SFU 有照送**：接收端 mid 4 的 `bytesReceived` 增加的量和發送端 mid 4 `f` 的 `bytesSent` 幾乎一樣（例：同一段時間 223 kB 對 222 kB）。要的是 `f`，`f` 也有資料。
- **解不出來是因為等不到關鍵幀**：接收端 `framesDecoded`、`keyFramesDecoded` 一直是 0，`pliCount` 每秒加約 3；發送端 `pliCount` 每秒加約 0.4（SFU 合併），**`keyFramesEncoded` 卻不動**（有一次收到 19 個 PLI 還是 1 個關鍵幀）。卡住的有兩種：連第一個 PLI 都不理，或第一個有回、但那個關鍵幀在接收端準備好之前就過去了，之後的 PLI 都不理。看得到分享的那些，幾乎都是第一個 PLI 回的關鍵幀就到了接收端（有一次隔了約 10 秒才等到下一個）。（Chromium、Firefox 當發送端沒有這樣量過；它們的分享在 CI 幾乎都第一次就過，Firefox 有一次 `decodes Fiona's screen` 失敗，症狀不同：畫面有出來，沒有查。）
- **鏡頭的編碼器在送分享的畫面**：只要 canvas 當畫面，Chromium 那邊 Wes 的**鏡頭格子**平均顏色就變成 248/251/250（白底），看得到分享的那幾次也一樣；鏡頭 mid 的位元組同時少到每幀不到 1 kB。那條 sender 的 `track` 還是鏡頭那條、`live`，Wes 自己的預覽也還是鏡頭，LongTalk 沒有換軌。

**排除的假設**：接收端要了沒送的層（要的是 `f`，有送）；`q` 那次 `tracks/update`（不要它照樣卡）；simulcast（一層照樣卡）；canvas 替身（`getUserMedia` 照樣卡）；換層後的關鍵幀（卡住時沒有換層，事後用 `tracks/update` 換層也救不回來）。

**結論**：問題在這個瀏覽器引擎同時跑兩個視訊編碼器的時候，不在 LongTalk 的選層或 SFU。這是由上面的證據推論，**沒有直接證明**：不經 LongTalk 與 SFU 的 loopback（同一頁兩條 PeerConnection）裡，WebKit 的接收端根本沒有畫面（`videoWidth` 0），分不出顏色，只看到第二個 sender 加入後，鏡頭編碼器從每秒約 28 幀掉到約 7 幀（Chromium 對照組維持約 20 幀）；也沒有讀 WebKit 的程式碼，不知道確切機制。

**卡住之後救不回來**：試過的都不可靠：`setParameters`（原樣、改 `scaleResolutionDownBy`、`active` 關開）、`replaceTrack`、接收端換層、分享中才關鏡頭（0／4 救回來）。少數幾次救回來和隔一陣子自己好分不開。所以只能在分享**之前**避開，#42 當時只讓測試先關鏡頭，產品沒動。

**決定（擁有者，2026-11-06）：WebKit 分享時先關鏡頭。** 沒有 Mac，測不到真的 Safari，但真的中了就是嚴重問題（別人看不到分享、鏡頭格子變成分享的畫面），先保護；Safari 其實沒事的代價只是分享時沒有鏡頭。

- 能力是 `capabilities.ts` 的 `shareStopsCamera`：能分享（`getDisplayMedia`），而且 `navigator.vendor` 是 `Apple Computer, Inc.`。Chrome、Edge、Firefox 完全不受影響（Firefox 那次 `decodes Fiona's screen` 症狀不同，也沒有這個問題的證據，不在保護範圍內）。為什麼不是 user agent、有人測過真的 Safari 之後怎麼拿掉，在 `BROWSER-SUPPORT.md` §3。
- 順序（`src/room/ShareCameraGuard.ts`，`ScreenShare` 的 `preparing`）：按分享 → 選擇器（要在點擊裡開；這時還沒動鏡頭，關掉選擇器什麼都沒變）→ 關鏡頭、toast → 等 `RoomMedia` 回報鏡頭不再送了（`replaceTrack(null)` 做完，最多等 3 秒；裝置已經停了，`RoomMedia` 的佇列也一定先處理鏡頭）→ 才向房間要分享、發布。
- 分享中鏡頭鈕是灰的（提示條與 tooltip 寫原因，快捷鍵 V 跳 toast）；裝置插回來之類自己打開的鏡頭會再被關掉。停止的每一條路（提示條、工具列、瀏覽器原生、主持人、房間拒絕）都會恢復**這個機制關掉的**鏡頭；本來就關著的不動，主持人關的也不動。純音訊模式中分享結束：鏡頭等模式結束才回來；分享中模式結束：鏡頭等分享結束才回來。本月只剩音訊時不恢復。session 重建不影響（裝置還是關的，`RoomMedia` 只重新發布分享）。

**沒有驗證的**：真的 Safari 會不會這樣。CI 的是 Playwright 的 Linux WebKit，不是 Safari。`e2e/crossbrowser.spec.ts` 現在按分享時鏡頭開著，靠上面這個機制，所以測到的是「使用者開著鏡頭按分享」這條路，但不是「兩個編碼器一起跑」：app 不會那樣送。要知道 Safari 需不需要這個機制，要實機（`DEPLOY.md` §5「Mac」）。如果將來要讓 Safari 同時送兩個，再回來做：發送端看 `pliCount` 漲而 `keyFramesEncoded` 不動（能力偵測，不看 user agent）的處理。

## 背景模糊（L4，2026-11-06，`e6-t06`，#50）

做法與決定在 `PRD/e6-audio-video-quality.md`「L4 的做法與決定」。媒體層相關的兩點：**處理後的軌和別的軌一樣經 `MediaTransport.replaceTrack` 換上去**，沒有新的 transceiver、不重新協商；**simulcast 是 sender 的參數**，換軌不影響。`e2e/local/blur.spec.ts` 用兩個 PeerConnection 量過：換上去後 `f`／`h`／`q` 三層（1280、640、320 寬）都繼續出幀，`negotiationneeded` 0 次；關掉換回原本的軌也一樣。CI 的互通測試（`e2e/interop.spec.ts`）再經真的 SFU 跑一次。

量測（2026-11-06，Windows、headless Chromium，**沒有 GPU，2D canvas 與 WebGL 都是軟體**；720p 假畫面、編碼三層 VP8；`BLUR_MEASURE=1`，`e2e/local/blur.spec.ts`）：

| | 全部行程 CPU（一核 = 100 %） | 三層 fps | 其他 |
| --- | --- | --- | --- |
| 鏡頭 | 82 % | 30 | |
| 背景模糊 | 195 % | 21 | 每秒 12 張遮罩、一張 19 ms（worker）；畫圖占頁面時間 78 % |

沒有編碼器、用真的 Y4M／MJPEG 假鏡頭的會議室頁：64 % → 95 %，29 fps。**這是最壞的情況，不代表真的筆電**：有 GPU 時 canvas 的畫圖大部分在 GPU；反過來，真的筆電同時還在解別人的視訊。要實機量（`DEPLOY.md` §5 第 33 步）。

## 只訂閱看得到的人（L1，2026-11-06，`e2-t18`、`e10-t01`、`e10-t02`，#49）

### 規則（`src/media/subscriptions.ts`，純函式，測試用假時鐘）

- **鏡頭**：格子把座位報給 `VideoDemandStore`（`TileSeat`，以鏡頭的 trackKey 為 key，沒訂閱也報）。在視線內停 150 ms 才訂閱（一路翻過的頁不訂閱）；離開 10 秒才退訂（`UNSEEN_GRACE_MS`，期間最低層）；分頁在背景 30 秒（`HIDDEN_GRACE_MS`）。分頁器（桌機 16 格、手機 4 格）自己說哪幾頁在畫面上，換頁立即生效；其他地方（格狀、條帶、大格）用 IntersectionObserver。
- **講話者例外**：`setVideoPriority` 留的鏡頭（釘選、聚光燈、大格、講話者，最多 2 個、各留 15 秒）不看畫面；分頁在背景時不留。
- **預先訂閱**：只在指標或焦點停在換頁鈕上時（`TileSightContext` 的 `near`，最低層）。手機慢慢滑到一半時下一頁已經算在畫面上。**和 PRD 原文不同**：一直預先訂閱下一頁，25 人兩頁的房間就是訂閱所有人。
- **聲音**：麥克風一律訂閱（PRD：不可見者退訂視訊但保留音訊）；靜音的麥克風不送封包，不花流量。50 人時要不要只收主持人與講話者留給 M3 `e10-t06`。
- **分享**：一律訂閱（最多 3 個），側列捲出去時最低層。
- **錄影**：`buildScene` 讀軌，不讀格子，所以這個瀏覽器在錄影時，錄影要畫的鏡頭（同意的人）不看畫面都收（`setVideoNeeded`），分頁在背景也收。代價：大房間錄影的人收到所有同意者的最低層。
- **優先順序**：純音訊模式 ＞ 頻寬自適應的停收（只留 kept）＞ 上面的規則。錄影不蓋過自適應（聲音優先）。`pausedVideos` 只有前兩者（格子說「網路不佳」），不在畫面上的是 `unseenVideos`（統計面板「收到的視訊」寫幾路、幾路沒訂閱，AC-10.1）。
- **格子**：別人的格子下面一直有名字首字，`<video>` 第一幀之前是透明的，所以先看到首字、再看到畫面，沒有黑格；不在畫面上、畫面還在路上的鏡頭不會被念成「鏡頭沒開」（`videoWaiting`），「隱藏沒有視訊的人」也不會把它藏起來（藏了就永遠訂閱不到）。

### 一次 SDP 交換一批（`MediaTransport.subscribeMany`、`unsubscribeMany`、`setPreferredLayers`）

Realtime 的 `tracks/new`、`tracks/close`、`tracks/update` 都收陣列（PR 預覽實測）。一頁的鏡頭是一個 POST ＋一個 renegotiate，不是 15 次；一條軌失敗（`empty_track_error`）只影響它自己，照舊退避重試；靜音的軌排在後面的批次（從沒送過封包的軌可能卡住整個呼叫約 8 秒）。每批最多 16 條，代理（`worker/sfu.ts`）放寬到 16。起始層在訂閱時就依座位大小與預算選好，不用等第二個 `tracks/update`。

### 實測中發現並修掉的

- **代理的 body 上限 64 KB**：約 20 條軌時 SDP 就超過，`tracks/close` 回 400，SFU 繼續送、瀏覽器卻停了（L1 之前 25 人的房間也會中）。放寬到 1 MiB。
- **靜音的麥克風被當成聲音有問題**（H2 起就有）：瀏覽器把沒有封包的時間算進 `concealedSamples`（靜音 4 秒 `concealedSamples` 比例 1.00，全是 `silentConcealedSamples`），只要房裡有一個人靜音，判斷就卡在 `fair`，**下行一旦被降級就回不來**（實測 15 個靜音麥克風：只剩 1 路鏡頭 7 分鐘）。現在扣掉靜音的部分、這段時間沒封包的軌不判。
- **在交換途中翻走**：還在 pending 的鏡頭也有寬限，不會一回來就關掉。
- **同一頁的格子相隔幾 ms 離開**：一起退訂（`GRACE_BATCH_MS`），也不會漏掉最後幾個。

### 實測（PR 預覽 #49，同一台電腦一個 headless Chromium，19 人：Zoe ＋ 18 個 bot，假鏡頭 1280×720，bot 的分頁算在背景所以不解碼鏡頭、麥克風靜音）

機器被 18 個編碼器佔滿（CPU-bound），時間偏慢，看位元率與訂閱數，不看 fps。`candidate-pair.bytesReceived` 算下行，`inbound-rtp` 算每路；每路最低層約 117 kbps。

| Zoe 看的 | 訂閱的鏡頭 | 下行 |
| --- | --- | --- |
| 桌機 1280×800 第 1 頁（15 格，全部 180p） | 15 | **2.29 Mbps** |
| 同上，所有人都訂閱（L1 之前的行為，指標停在換頁鈕上量到的） | 18 | **2.75 Mbps** |
| 桌機第 2 頁（3 格＋留著的講話者） | 6 | **0.90 Mbps** |
| 手機 390×844 第 1、2 頁（4 格一頁＋留著的講話者；這個 headless 是 1 倍像素，都是 180p） | 5–6 | **0.78–0.97 Mbps** |

所以大部分人不在畫面上時，下行約是原本的 1／3；以 25 人算，L1 之前至少 24 × 117 kbps ≈ 2.8 Mbps，手機約剩 1 Mbps（25 人是**算的**，正式測試是 L2）。

| 從換頁到每格都解出第一幀 | 第一格 | 中位 | 最後一格 | SFU 呼叫 |
| --- | --- | --- | --- | --- |
| 寬限內翻回去（15 格、3 格） | 30–120 ms | 30–150 ms | 30–150 ms | **0** |
| 寬限後到第 2 頁（3 格） | 0.9–2.0 s | 0.9–2.0 s | 0.9–2.8 s | 1 POST ＋ 1 renegotiate |
| 寬限後回第 1 頁（10–15 格，一批） | 60–80 ms（留著的那幾格） | 1.0–2.0 s | 1.7–2.7 s，有一次 5.0 s | 1 POST ＋ 1 renegotiate |

- 來回翻頁 3 輪（每輪超過寬限）：m-section 停在 35 條（SFU 重複使用），下行回到 2.35–2.47 Mbps，沒有累積。
- 講話者側格：Zoe 在第 2 頁、第 1 頁的 bot 講過話：右欄出現「正在講話（不在這一頁）」、有畫面，翻到他那頁時回到格子裡（單元測試）。
- **這台機器量不到的**：一個瀏覽器程序最多開 16 條音訊輸入（第 17 個 bot 起 `getUserMedia` 的麥克風開不了），所以量測的 18 個 bot 只有 15 條麥克風；L2 要分程序或分機器。

### 免費額度

伺服器估算原本假設每人收每一條 cam 1.5 Mbps；取大的那個記帳，所以 L1 省的流量記不到帳（25 人一小時算成約 400 GB）。改成每個接收端的視訊最多算 6 Mbps（`MAX_ASSUMED_VIDEO_BPS`，AC-10.3 的上限）；瀏覽器回報的實際值照舊取大的。

### 沒有驗證的

- 兩台真的裝置、真的鏡頭、真的麥克風（AC-10.1、AC-10.2 不勾，`DEPLOY.md` §5 第 34 步）；真的鏡頭比假鏡頭難壓，第一幀可能不同。
- 25 人（L2）；錄影時翻頁只有單元測試，沒有在預覽上量；Safari、Firefox 的 `silentConcealedSamples`（讀不到時，沒封包的區間照樣不判，剛靜音的那一個區間可能是 `fair`）。

## 分享的第一個畫面（2026-11-13，擁有者實測回報「分享後對方要等很久才看得到」）

從程式推算（沒有實測）：從選好畫面到對方看到，中間要依序走完宣告分享、發布、等第一批封包、`tracks`、訂閱的兩次 SDP 交換，然後**等關鍵幀**。拖最久的是最後一段：接收端先要 `f`（1080p 的關鍵幀大，在 1 Mbps 左右的估計下光送就要 1–3 秒），400 ms 後選層常換成 `h`，畫面出來後又可能換回 `f`，每換一次都要再等新那層的關鍵幀；靜止的畫面只有被要求才送關鍵幀，SFU 又把 PLI 合併（上面 WebKit 一節量到傳到發送端約每秒 0.4 次）。另外 Chrome 要等頻寬估計夠 `h` 加上 `f` 的最低值（約 0.6＋0.8 Mbps）才開 `f`，分享剛開始常常不夠。

改法：
- **先收 `h`、畫面出來前不換層**：螢幕的起始層改 `medium`（`INITIAL_LAYER`）；新訂閱的螢幕在格子回報畫面尺寸（第一幀畫出來）之前不重新選層，最多 4 秒（`SCREEN_FIRST_FRAME_HOLD_MS`）。`h` 是發送端從第一幀就一定在送的那層，關鍵幀約 1080p 的四分之一。
- **分享仍然送兩層**：考慮過只送一層（小房間也一樣，房間會變大）和一開始只開 `f`，都會讓手機和網路差的人在前幾秒（或一直）收 1080p、沒有退路，所以不採用。新分享發布時把上行自適應裡螢幕那一步退回去（`UplinkAdaptation.shareStarted`；之前沒在分享時步驟會跳過螢幕那步，下一次分享一發布 `f` 就被關掉）。
- **催關鍵幀**：訂閱到螢幕 300 ms 後用同一層再送一次 `tracks/update`（`MediaTransport.requestKeyFrame`），1.5 秒時格子還沒畫面就再送一次；預期 SFU 換選層時會向發送端要關鍵幀，**沒有驗證**。發送端在第一批封包 1 秒後（第一批看的人差不多這時候訂閱到）呼叫 `RTCRtpSender.generateKeyFrame()`（有才呼叫）。
- **其他**：等第一批封包的輪詢 100 → 40 ms；螢幕單獨一批先訂閱，訂不到的第一次重試 400 ms（原本 2 秒，其他軌照舊）；Safari 先關鏡頭的備用等待 3 → 1 秒（平常 `cameraGone` 會先到）。
- 預期省下：一般情況少等 1–3 個關鍵幀（每個約 0.3–3 秒）；訂閱失敗時第一次重試少 1.6 秒；Safari 鏡頭沒回報時少 2 秒。要用兩台裝置實測（接收端 `keyFramesDecoded` 與第一個 `framesDecoded` 的時間）才算數。

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
