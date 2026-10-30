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

- **前端**：React 19 ＋ TypeScript（strict）＋ Vite ＋ styled-components，和淡江牌桌同一套；由同一個 Worker 的靜態資產提供（A1 起；原規劃是 Pages，理由見 `DEPLOY.md`）。路由：`/`（首頁）、`/r/:roomId`（會議室）、`/me`（登入者的房間與錄影，M1）。
- **Worker**：HTTP API 與 WebSocket 升級；把 `/api/rooms/<id>/ws?v=<協定版本>` 的 WebSocket 轉給該房的 Durable Object（`idFromName(<id>)`）。WebSocket 放在 `/api/*` 底下，`run_worker_first` 不必另外列路徑；`/r/:roomId` 只是前端路由。
- **RoomDO**：單一房間的真相來源。狀態：成員（id、名字、角色、連線狀態、心跳時間）、每位成員的軌道（mic／cam／screen 的 on/off 與 SFU track id）、等候室、鎖房、聊天 200 則、標註與白板（M2）、錄影狀態。用 `alarm()` 做空房關閉與計時。推送只送差異（和牌桌 `views.ts` 同一手法）。
- **RoomDO 現況（A3）**：`worker/room.ts` 只是接 Cloudflare 的膠水（storage、alarm、hibernation WebSocket，每個 socket 以成員 id 為 tag、attachment 存成員資料，醒來時從 socket 重建成員）；房間邏輯在 `worker/room-host.ts` 的純類別 `RoomHost`，Vitest 直接測。訊息型別在 `shared/protocol.ts`（有版本號，連線帶 `?v=`，版本不合以 4400 關閉）；差異是 `shared/patch.ts` 的 `set`／`del` 路徑操作，每個 patch 帶遞增 `rev`，瀏覽器發現缺號就送 `resync` 拿 `snapshot`。storage 只存房間資訊與 `rev`；成員不寫 storage。房間 id 是 10 碼 base58（去掉 0、O、I、l，約 58.6 bits），由 `POST /api/rooms` 產生並在 RoomDO 初始化；沒建過的 id 連 WebSocket 以 4404 關閉。
- **Realtime SFU**：每位成員一個 SFU session；發布自己的軌（push），依 RoomDO 告知的 track id 訂閱別人的軌（pull）。SFU 的 API 呼叫由 Worker 代理（App token 不進瀏覽器）。
- **TURN**：Worker 發短期憑證給瀏覽器；ICE 設定一律含 TURN，只在直連失敗時用到。
- **R2**：聊天檔案（24 小時）、雲端錄影（有效期）、白板匯出。
- **錄影（M2）**：ADR 待寫（`e8-t04`）：Realtime 的錄製能力 vs 自架 headless 瀏覽器合成。M1 的本機錄影完全在瀏覽器（Canvas＋Web Audio＋MediaRecorder）。
- **遠端控制（M3）**：Tauri 桌面端代理作為「另一種客戶端」連進同一個 RoomDO，發布螢幕軌、接收控制事件（DataChannel 或 WebSocket，簽章）。

## 3. 為什麼是 Cloudflare Realtime SFU（而不是 P2P mesh 或自架）

| 選項 | 優點 | 缺點 | 判斷 |
| --- | --- | --- | --- |
| P2P mesh（沒有伺服器） | 最省、零成本 | 每人上傳 N−1 份視訊，4 人就吃力、8 人不可能；之後一定重寫 | 不採用；連 M0 都不用，避免重寫 |
| **Cloudflare Realtime SFU** | Anycast 全球節點、免費流量額度、無主機可維運、與 Workers／DO 同一生態、TURN 同家 | 封閉服務、功能比 LiveKit 少（沒有內建錄製管線、沒有 SDK 幫做 simulcast 選層）、價格可能變 | **第一選擇**。缺的功能自己在 RoomDO 與前端做 |
| LiveKit Cloud | 功能最齊（simulcast、錄製 egress、SDK） | 免費額度較小、第二家供應商、帳號與計費另一套 | 後備；`MediaTransport` 介面保留可切換 |
| 自架 LiveKit／mediasoup | 完全掌控、無限流量 | 要一台有公網 IP 的主機、要維運、要自己做 TURN | 不採用，除非流量超過免費額度且付費更貴 |

**規則**：所有媒體相關的呼叫經過 `src/media/MediaTransport.ts` 介面（`connect`、`publish`、`subscribe`、`unpublish`、`setPreferredLayer`、`getStats`、`close`）。`CloudflareRealtimeTransport` 是第一個實作；介面的測試用假實作跑。

## 4. 資料流：一個人進房

1. 瀏覽器 `GET /r/abc123` → Worker 的靜態資產回 SPA。
2. 名字畫面後，`POST /api/rooms/abc123/join`（名字、本機 session token）→ Worker 轉給 RoomDO → 回成員 id、角色、房間快照、TURN 憑證、SFU session 建立所需資訊。
3. 瀏覽器開 WebSocket 到 RoomDO；之後所有狀態變化走這條。
4. 瀏覽器建立 SFU session，發布 mic／cam 軌；把 SFU track id 回報 RoomDO（`publish` 訊息）。
5. RoomDO 廣播「成員 X 有新軌」；其他瀏覽器向 SFU 訂閱該軌。
6. 心跳每 15 秒（文字 `ping`，由 runtime 自動回 `pong`，不喚醒 DO；每 15 秒的 alarm 讀 `getWebSocketAutoResponseTimestamp` 檢查，45 秒沒心跳就關 socket 並移除成員）；A3 還沒有身分，socket 關閉就移除成員。A4 起：斷線時 RoomDO 保留成員 60 秒並標示「重新連線中」；回來後以同一 session token 接回、重新發布與訂閱。
7. 最後一人離開 10 分鐘後，`alarm()` 清房間（持久房間除外）。

## 5. 安全邊界

- SFU App token、R2 憑證只在 Worker；瀏覽器只拿短期、限範圍的憑證。
- 誰能靜音別人、踢人、開始錄影、取得標註權限：只在 RoomDO 判斷（`roles.ts`），前端只是按鈕。
- 房間 id 用 URL-safe 的 10 字元隨機字串（約 59 bits），不可列舉；鎖房、等候室、密碼在 M1。
- 錄影、逐字稿、遠端控制三件事一律「全員可見的狀態 ＋ 明確同意」，寫進 RoomDO 狀態而不是前端旗標。

## 6. 成本模型（粗估，動工後以儀表板為準）

| 項目 | 假設 | 每月免費額度（規劃時） | 說明 |
| --- | --- | --- | --- |
| SFU 流出 | 4 人、720p 1.5 Mbps、每人收 3 路 ⇒ 18 Mbps ⇒ 2 小時約 16 GB | 1 TB | 約 60 場 4 人 2 小時；8 人會議約 4 倍流量，simulcast 後接收端可降層 |
| TURN | 10–15% 的連線走 TURN | 1 TB | 儀表板追蹤比例 |
| Workers／DO | 每房一個 DO，每秒數則訊息 | 免費方案 | 和牌桌同等級 |
| R2 | 聊天檔案 24 小時、錄影有效期 | 10 GB | 雲端錄影是主要用量，M2 才有 |

超額時的自動降級順序（E11 `e11-t09`）：關雲端錄影 → 限制 HD → 降低 simulcast 最高層 → 限制人數。

## 7. 與淡江牌桌的關係

同一套技術與文件方法，**不共用程式碼與帳號**（使用者群不同）。可以複製的：WebSocket 差異推送、心跳與重連、`roles.ts` 的權限表寫法、Playwright 視覺回歸、CI 效能預算腳本。
