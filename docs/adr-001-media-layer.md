---
title: ADR-001 — 媒體層：Cloudflare Realtime SFU
date: 2026-10-30
status: accepted（兩台裝置實測前為暫定；實測不通過就照「切換條件」改 LiveKit）
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
- **每個 session 同一時間只能有一次 SDP 交換**：`CloudflareRealtimeTransport` 把所有變更排成一個佇列。
- 錯誤看三層：HTTP 狀態、頂層 `errorCode`、每條軌的 `errorCode`。
- **simulcast**：發布端 `sendEncodings` 用 rid `f`／`h`／`q`（1、½、¼ 解析度）；接收端 `preferredRid` 搭配 `priorityOrdering`／`ridNotAvailable: 'asciibetical'`，字母越前面越優先，所以 `f` 是最高層。`Layer` 對應：`high→f`、`medium→h`、`low→q`。
- **TURN**（`e2-t07`）：`POST https://rtc.live.cloudflare.com/v1/turn/keys/{TURN Key ID}/credentials/generate-ice-servers`，標頭 `Authorization: Bearer <TURN Key API Token>`，body `{"ttl": 秒數}`，回 `{ iceServers: [...] }` 直接給 `RTCPeerConnection`。清單可能含 port 53 的 URL，瀏覽器會擋，不用 trickle ICE 時要濾掉。A2 先只用 `stun:stun.cloudflare.com:3478`。
- **錄製**：Realtime SFU 沒有內建錄影。WebSocket adapter（GA）能把音訊以 PCM、視訊以 JPEG 幀送到自己的 WebSocket 端點：適合即時逐字稿（E8），不適合錄完整視訊。雲端錄影的選項（自架合成 vs RealtimeKit 錄影）留給 `e8-t04`。這回答了 E2「未決問題」的第一題。

## `MediaTransport` 介面（定稿）

```ts
interface MediaTransport {
  readonly sessionId: string | null
  readonly state: ConnectionState // new | connecting | connected | reconnecting | failed | closed
  connect(options?: { iceServers?: RTCIceServer[] }): Promise<void>
  publish(track: MediaStreamTrack, options: { kind: TrackKind; simulcast?: boolean }): Promise<PublishedTrack>
  unpublish(trackName: string): Promise<void>
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
- `FakeTransport`（`src/media/FakeTransport.ts`）：同一個 `FakeSfu` 建出來的 transport 互相 publish／subscribe，`useRoomMedia`（`e2-t04`）的測試用它跑。

## 後果

- **要自己做的**：房間與軌清單（RoomDO，A3／B1）、desired／actual 訂閱對齊（`e2-t04`）、重連（`e2-t08`）、選層策略（`e2-t12`、`e2-t15`）、統計（`e2-t13`）。這些 LiveKit SDK 會送，Realtime 不會；已經排進 E2 的 task。
- **Worker 代理是信任邊界**：A2 的 `/api/sfu/*` 還沒綁房間成員。**B1（`e2-t03`）已綁定**：路徑帶房間 id，RoomDO 的 `sfuAccess` 只接受該房成員的 session token（不然 401）；建立 session 後 `bindSfu` 把它記成該成員的（同一成員再建一個就取代舊的，舊 session 的軌清單清掉），之後對這個 session 的呼叫只接受它的主人（不然 403）；pull 的每條軌都必須是同房成員正在發布的（不然 404 `track_not_in_room`）。push 的軌種類從 offer 的 m-line 讀出，給免費額度保護用（`DEPLOY.md` §6）。
- **兩個 secret**：`REALTIME_APP_ID`、`REALTIME_APP_SECRET`（`DEPLOY.md` §5）；TURN 另外兩個（`e2-t07`）。
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
