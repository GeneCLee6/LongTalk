---
title: ADR-002 — 端對端加密（E2EE）可行性
date: 2026-11-13
status: accepted（結論是「現在不做」；觸發條件出現時照「什麼時候重新考慮」先做一天的 spike）
task: e11-t10
---

# ADR-002 — 端對端加密（E2EE）可行性

## 背景

`00-prd.md` 把 E2EE 列為研究題，不是承諾；AC-11.9 要的是這份 ADR。要回答三件事：在 Cloudflare Realtime SFU 上**做得到嗎**、對已經做好的功能（錄影、標註、白板、桌面代理、分組討論室、模糊、選層）**有什麼影響**、**值不值得現在做**。

LongTalk 現在保證的（隱私權政策頁照這段寫，`/privacy`）：

- **媒體**：瀏覽器到 Cloudflare 之間是 DTLS-SRTP，**一段一段**加密（hop-by-hop）。Realtime SFU 在 Cloudflare 的機器上把封包解開、再加密轉給每個人；技術上 Cloudflare 的機器在記憶體裡看得到聲音與畫面。伺服器**不存**任何媒體（只有本機錄影）。
- **信令與房間狀態**：WebSocket over TLS 到 RoomDO；聊天、私訊（O4）、標註、白板、投票都以明文存在 RoomDO（白板在 R2），會議結束或到期刪除（`e11` 保留表）。
- **TURN**：轉送的是已經 DTLS-SRTP 加密的封包，TURN 看不到內容。

所以「誰看得到」：網路上的人看不到；Cloudflare（SFU 的機器）與擁有者（能改 Worker 程式的人）在技術上看得到。E2EE 要拿掉的是後面這兩個。

## 威脅模型（LongTalk 的實際情況）

| 誰 | 現在看得到媒體？ | E2EE 之後 |
| --- | --- | --- |
| 網路上的人（咖啡店 Wi-Fi、ISP） | 看不到（DTLS-SRTP） | 看不到 |
| Cloudflare 的 SFU／TURN 機器 | 技術上看得到（SFU 解開再加密） | 看不到 |
| 擁有者（部署 Worker 的人）或被入侵的 Worker | 不能直接看媒體（媒體不經 Worker），但可以改前端程式、偷發 token、把自己加進房間 | 看金鑰怎麼發：**金鑰經 RoomDO 發 → 擋不住**；金鑰不經伺服器 → 擋得住被動偷看，擋不住「改前端程式」 |
| 房裡的其他人 | 看得到（本來就是要給他們看） | 看得到 |

最後一列很重要：**網頁版的 E2EE 永遠擋不住送程式的人**。前端程式每次都從 Worker 下載；擁有者或入侵者改程式，就能把金鑰送出去。Zoom、Google Meet、Jitsi 的網頁版都有同一個限制。LongTalk 只給朋友用、擁有者自己維運（`internal-friends-only`），擁有者本來就在信任範圍內，所以 E2EE 實際上多擋的是「**Cloudflare 的機器**」。

## 技術上做得到嗎：做得到

### 怎麼加密：Encoded Transform（Insertable Streams）

WebRTC 的 Encoded Transform 讓網頁在**編碼之後、封包化之前**拿到每一個影格（`RTCEncodedVideoFrame`／`RTCEncodedAudioFrame`），可以把 payload 加密；收的一方在解碼之前解密。SFU 只看到 RTP 標頭與加密過的 payload，照常轉送。加密在 Web Worker 裡做（WebCrypto AES-GCM，每格一個 IV），不佔主執行緒。

瀏覽器支援（要用能力偵測，`src/media/capabilities.ts` 會多一項 `encodedTransform`；**全部未實測**）：

| 瀏覽器 | API | 備註 |
| --- | --- | --- |
| Chrome、Edge（電腦、Android） | 標準 `RTCRtpScriptTransform`：第三方相容表寫 141 起；更早的版本只有非標準的 `createEncodedStreams()`（86 起，PeerConnection 要用 `encodedInsertableStreams: true` 建立） | 兩套 API 都要寫，或只支援 141 以上 |
| Firefox | `RTCRtpScriptTransform`，117 起 |  |
| Safari（macOS、iOS；iOS 上所有瀏覽器） | `RTCRtpScriptTransform`，15.4 起 |  |
| 桌面代理（N2，Tauri） | Windows 是 WebView2（Chromium），同 Chrome；macOS 是 WKWebView | macOS 要另外驗 |

不支援的瀏覽器**不能加入**加密的會議（不能退回明文，否則就不是 E2EE）：要在預先加入頁說清楚。

### Realtime SFU 能不能轉送加密的影格：能，有前例

Cloudflare 自己的開源範例 **Orange Meets** 在 2025 年加了 E2EE（部落格〈Orange Me2eets〉），資料面就是 Realtime SFU，**SFU 沒有為此改任何東西**。它的做法：

- Rust 寫的 Web Worker 加密每一格；
- 為了相容 VP8，**每格開頭的幾個位元組不加密**（照 Discord DAVE 協定的做法），SFU 與接收端的解封包器還讀得到 VP8 的 payload descriptor；
- 金鑰用 **MLS**（RFC 9420，持續的群組金鑰協商），新的人加入時由一位「指定的提交者（designated committer）」產生群組更新；有「安全碼」讓大家互相核對，防中間人。

**還沒驗證的**（LongTalk 特有，Orange Meets 沒說）：

1. **Simulcast 選層**（H1，`src/media/layers.ts`）：Realtime 換層要等關鍵幀。不加密 VP8 開頭的位元組時，SFU 應該還認得出關鍵幀；要實測換層與 `generateKeyFrame()`（#53）照常。
2. **分享的「文字／動態」模式**（H5）與 `degradationPreference`：在編碼端設定，不受影響（推論，未驗證）。
3. **統計與額度計數**（e11-t13）：只看位元組數，不受影響；加密每格多 ~16–28 位元組（GCM tag＋IV），流量多不到 1%。

## 對現有功能的影響

| 功能 | 影響 |
| --- | --- |
| 本機錄影（I4） | 不受影響：錄的是錄影者瀏覽器裡解密、解碼後的軌。同意流程照舊（規則 4）。 |
| 雲端錄影、逐字稿、AI 摘要（Phase K，已跳過） | **做不到**，除非伺服器端有一個持有金鑰的「錄影機器人」成員，那就等於把金鑰交給伺服器。E2EE 會議裡這些功能必須關掉。 |
| 標註、白板、聊天、私訊、投票 | **不在媒體裡**，走 RoomDO 的 WebSocket、以明文存在 RoomDO／R2。媒體 E2EE 保護不到它們；要保護得另外加密這些訊息的內容，而且伺服器就不能再檢查內容（例如標註的上限、聊天的長度只能看密文長度）。 |
| 背景模糊、噪音抑制、省電模式 | 在編碼之前做，不受影響。 |
| 說話偵測、每人音量 | 在接收端解碼之後算，不受影響。 |
| 分組討論室（L3） | 隔離現在由 RoomDO 保證（伺服器擋訂閱）。E2EE 時每個分組要有自己的金鑰，移動的人換金鑰；主持人巡房要拿到每組的金鑰。 |
| 桌面代理（N2–N5） | 代理分享螢幕也要加密（WebView2 可以，macOS 要驗）。**遠端控制事件刻意經過 RoomDO**（N1 威脅模型：伺服器檢查授權與序號，規則 1），E2EE 不改變這個決定。 |
| 人數與效能 | 每格多一次 AES-GCM，手機上 25 人的解密量要實測；Orange Meets 用 WASM，WebCrypto 的非同步呼叫在高幀率時可能是瓶頸。 |
| JS 預算 | 加密 Worker 與金鑰協商都 lazy，只在加密會議載入；MLS 的 WASM 可能上百 kB（不算進會議室頁的 350 kB，但要量）。 |
| 能力偵測與支援表 | `BROWSER-SUPPORT.md` 多一列；舊版 Chrome、某些內嵌瀏覽器（LINE 的內建瀏覽器）可能不能加入。 |

## 選項：金鑰怎麼發

| 選項 | 怎麼做 | 擋得住 | 擋不住 | 工作量 |
| --- | --- | --- | --- | --- |
| **A. 經 RoomDO 發一把房間金鑰** | RoomDO 產生金鑰，用 WebSocket 發給每位成員；有人離開就換一把 | Cloudflare 的 SFU／TURN 機器（但 RoomDO 也在 Cloudflare） | RoomDO、擁有者、被入侵的 Worker、Cloudflare（DO 也是它的） | S |
| **B. 金鑰放在連結的 `#` 後面** | 開房時瀏覽器產生金鑰，連結變成 `/r/<id>#k=<金鑰>`；`#` 後面不會送到伺服器 | SFU、TURN、RoomDO、被動偷看的伺服器 | 拿到連結的人（連結貼在 LINE 群組＝金鑰也在那裡）、改前端程式的人；**有人離開不能換金鑰**（換了要重發連結） | M |
| **C. MLS 群組金鑰（Orange Meets 的做法）** | 每個人有自己的金鑰對，經 RoomDO 轉送 MLS 訊息，加入、離開都換群組金鑰；安全碼讓大家核對 | 上面全部，加上「離開的人聽不到之後的內容」；核對安全碼後也擋得住伺服器做中間人 | 改前端程式的人（網頁版共同的限制）；沒有核對安全碼時的中間人 | L（MLS 函式庫、提交者選擇、斷線重連時的狀態、分組討論室各一個群組） |

A 幾乎沒有價值：信任的對象沒有變（RoomDO 與 SFU 是同一家），卻付出所有相容性的代價。

## 決定

**現在不做 E2EE。** 在 Cloudflare Realtime 上技術可行（Orange Meets 證明了 SFU 不用改），但對 LongTalk 的值得程度低：

1. **多擋的只有 Cloudflare 的機器**。只給朋友用、擁有者自己維運，網頁版又擋不住送程式的人；DTLS-SRTP 已經擋住網路上的人。
2. **代價實在**：舊瀏覽器與某些內嵌瀏覽器不能加入、Chrome 兩套 API、雲端錄影類功能永遠關掉、標註與聊天另外處理、Simulcast 換層要重新驗證，每一項都要兩台裝置實測（規則 7）。
3. **免費額度與 JS 預算都不受威脅**，所以將來要做不會被成本擋住；這是「可以晚點做」而不是「做不到」。

現在要做的只有**說清楚**：隱私權政策與介面不宣稱端對端加密（已經是這樣：`00-prd.md`「媒體走 DTLS-SRTP（不是端對端加密）」，`/privacy` 同樣）。

## 什麼時候重新考慮，怎麼開始

觸發條件（任一）：

- 擁有者或朋友要開「連 Cloudflare 都不該看到」的會議（例如醫療、法律諮詢）；
- Cloudflare Realtime 的條款或資料處理方式改變；
- LongTalk 開放給朋友以外的人（那時也要重談 O3 多租戶）。

到時候：

1. **一天的 spike**（PR 預覽，兩台裝置）：照 Orange Meets 的做法，對 VP8 與 Opus 用 `RTCRtpScriptTransform` 加一把寫死的金鑰（VP8 關鍵幀開頭 10 位元組、其他格 3 位元組、Opus 0 位元組不加密），確認：互看互聽、simulcast 換層、`generateKeyFrame()`、分享第一個畫面的時間（#53）、Safari 與 Firefox、手機上 8 人的 CPU。任何一項不行就停在這裡。
2. **選 B 還是 C**：只要「朋友之間、連結當鑰匙」就選 **B**（一批，`MediaTransport` 的 `connect` 多一個 `e2ee` 選項，Realtime transport 掛 transform；RoomDO 房間設定「加密會議」只記一個旗標，讓不支援的瀏覽器在預先加入頁就被告知）。要「離開的人聽不到之後的內容」與防中間人就選 **C**（兩到三批，參考 Orange Meets 的開源程式）。
3. **一起改**：`BROWSER-SUPPORT.md` 多一列、隱私權政策、`DESIGN.md` 的「加密會議」標示、錄影同意文字（本機錄影仍可錄，要寫清楚）。

規則 2（媒體只經 `MediaTransport`）讓這件事的影響範圍很小：加密只在 `CloudflareRealtimeTransport` 與一個 lazy 的 Worker 裡，元件不用改。

## 參考

- Cloudflare 部落格〈Orange Me2eets: We made an end-to-end encrypted video calling app and it was easy〉（2025-06-26）
- W3C WebRTC Encoded Transform；SFrame（RFC 9605）；MLS（RFC 9420）
- `docs/PRD/f-remote-control-security.md`（控制事件為什麼經 RoomDO）
- ADR-001（媒體層、simulcast、分享的第一個畫面）
