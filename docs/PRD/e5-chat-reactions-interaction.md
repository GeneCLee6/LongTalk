---
title: E5 — 聊天、反應與互動
date: 2026-10-28
status: in progress
epic: E5
owner: GeneCLee6
milestones: [M0, M1, M2]
depends_on: [E2, E4]
---

## 背景

會議中的文字聊天在 M0 就要有（貼連結、講不出口的字、網路差時打字）。M1 補 Zoom 使用者習慣的反應、舉手、傳檔；M2 加投票與計時器。這些都是 RoomDO 裡的小狀態，難度不在技術，在於介面不要吵、不要擋到視訊。

## 目標

- M0：房內聊天，連結可點，保留本場 200 則，未讀數。
- M1：表情反應浮出、舉手排序清單、檔案與圖片（R2，24 小時）。
- M2：投票、計時器與議程條。

## 非目標

- 會後保留聊天（房間關閉即清除；持久房間 M2 再議）。
- 私訊（M2 選用，`e5-t09`）。
- 訊息加密、已讀回條。

## 需求

- 聊天：文字 ≤ 2000 字、Markdown 不支援（只做連結偵測與換行）、顯示名字與時間、自己的在右側；RoomDO 保留最近 200 則，新進者收到全部；側欄關閉時工具列顯示未讀數並有短暫氣泡預覽；速率限制每人每 10 秒 10 則。
- 反應：👍 ❤️ 😂 😮 👏 🎉 六種；從反應者的格子浮出 5 秒；同時多人反應會疊；可關閉顯示。
- 舉手：舉手後名牌顯示手、參與者面板依舉手時間排序並置頂；本人或主持人可放下；有音效（E4）。
- 檔案（M1）：聊天面板的附件按鈕；圖片（png／jpg／webp／gif）與一般檔案；單檔 25 MB；上傳到 R2（Worker 簽章 URL）；圖片顯示縮圖、點開預覽；房間關閉 24 小時後刪除（E11 清除排程）；掃描副檔名黑名單（exe、bat 等）。
- 投票（M2）：主持人建單選／多選、匿名可選、即時結果、結束後貼到聊天。
- 計時器與議程條（M2）：主持人設倒數，全員頂部可見；議程條列出項目與預計時間，目前項目高亮。

## 設計方向

- `shared/protocol.ts` 加 `chat.*`、`reaction`、`hand.*`、`poll.*`、`timer.*` 訊息；全部走 RoomDO 既有 WebSocket。
- 反應與舉手的動畫在 `Tile` 上疊一層，不改版面。
- 檔案上傳（I5 定案，和原本的寫法不同，見下面）：`POST /api/files/<房>` 向 RoomDO 要一次性的上傳許可 → `PUT` 把檔案**經 Worker** 串流到 R2 綁定 → RoomDO 自己寫一則帶檔案卡片的聊天訊息。R2 物件 key 帶**小時**（`uploads/2026-11-05T13/<id>`），清除排程只看 key。

### 上傳為什麼走 Worker，不用簽章直傳（I5 決定，和 PRD 原文不同）

原本寫的是「Worker 簽章 URL、瀏覽器直傳 R2」。實作前比較過：

| | 簽章直傳（presigned URL） | 經 Worker 串流到 R2 綁定（採用） |
| --- | --- | --- |
| 擁有者要設定 | 建 R2 API token（S3 憑證，多一個 secret）、bucket 的 CORS 規則 | **什麼都不用**：綁定就夠了 |
| CSP | `connect-src` 要加 `*.r2.cloudflarestorage.com` | `connect-src 'self'` 不變 |
| 大小限制 | 簽章只能限宣告的長度，**邊傳邊數做不到** | Worker 看得到每個 byte，`FixedLengthStream` 多一個 byte 就失敗 |
| 內容檢查 | 只能傳完才讀（已經寫進 R2，要再刪） | 前 4 KB 看完才開始寫 R2 |
| Worker 請求大小 | 不經過 | 免費方案上限 100 MB，25 MB 放得下 |
| 免費額度 | R2 Class A、無 Worker 流量 | R2 Class A 一樣；多一次 Worker 請求與幾次 DO 請求。Worker 流量不計費 |
| CPU | 幾乎沒有 | 只讀開頭；之後是原生 `pipeTo`，每個 chunk 不跑 JavaScript，CPU 不隨檔案變大（`scripts/abuse.ts` 在預覽上真的傳 25 MB） |

上傳一定是同網域，下載也是：瀏覽器帶 session token 用 `fetch` 取得（`Authorization`），**連結本身打不開任何東西**，上傳的網頁不可能在分頁裡以 LongTalk 的網域執行。

### 檔案規則（數字在 `shared/file-limits.ts`，規則在 `shared/files.ts`）

- **大小**：單檔 25 MB；請求一定要有 `Content-Length`（瀏覽器傳 `File` 一定有，沒有回 411）且要等於許可宣告的大小，`FixedLengthStream` 邊傳邊擋，超過或不足都不會留下任何東西（R2 的 put 是全有或全無）。
- **黑名單**：副檔名（程式、安裝檔、指令碼、捷徑、磁碟映像、HTML、SVG、XML）與宣告的 MIME；檔名先清理（路徑、控制字元、雙向覆寫、開頭的點、結尾的點與空白），所以 `a.exe.` 也擋得到。Office 檔與 ZIP 可以傳。
- **看內容**：前 4 KB 決定：PNG、JPEG、GIF、WebP 的 magic 才算圖片；PE、ELF、Mach-O、`#!`、HTML、SVG（含 BOM、空白、UTF-16）不管檔名是什麼都擋；宣稱是圖片但內容不是，回 `not_an_image`。縮圖也一樣檢查。
- **誰**：權限表 `uploadFile`、`downloadFile`（主持人、共同主持人、參與者；等候室不行），RoomDO 判斷；許可是一次性、綁成員、綁大小，2 分鐘內要開始、30 分鐘內要傳完。
- **下載**：只有這間房的成員、只有這間房的檔案、只在 24 小時內。`X-Content-Type-Options: nosniff`、`Content-Security-Policy: default-src 'none'; sandbox; frame-ancestors 'none'`、`Cross-Origin-Resource-Policy: same-origin`、`Cache-Control: private, no-store`；只有內容確認過的安全圖片是 `inline` 且用內容判斷出的型別，其他一律 `application/octet-stream`＋`attachment`。
- **配額**（AC-11.5）：每位成員 30 個檔、150 MB；每間房 100 個檔、500 MB；每個網路 10 分鐘 15 次、一天 40 次（`GuardDO`）；全站 `longtalk-files` 最多 2 GB（`FileLedgerDO` 記帳，每小時用 R2 實際清單校正），超過回 507 `storage_full`。數字的理由寫在 `shared/file-limits.ts`。
- **24 小時**：下載從上傳開始算滿 24 小時就回 410；物件由每小時的 Cron 刪除（`worker/sweep.ts`，實際在 24–25 小時之間）。房間先關閉的話，它的檔案當場一起刪（最多 24 小時，不是原本寫的「房間關閉後 24 小時」，比較符合「聊天只留在這場會議」）。`e11-t08`。
- **縮圖**：瀏覽器在上傳前用 canvas 做最長邊 480 px 的 JPEG（≤ 256 KB，沒有 Cloudflare Images，它要付費）；聊天只抓縮圖，不會讓每個人都下載 25 MB。做不出來（HEIC、解不開）就沒有縮圖，圖片卡片多一個「檢視」。

## 驗收條件

- [ ] AC-5.1 — 房內聊天：200 則保留、新進者收到歷史、連結可點、未讀數與氣泡預覽、速率限制；手機抽屜版可用。
- [x] AC-5.2 — 六種反應從格子浮出 5 秒、可疊、可關閉顯示。（G3 #26：單元測試＋e2e 三個瀏覽器互看）
- [ ] AC-5.3 — 舉手：名牌與面板排序、本人或主持人放下、音效。（G3 #26 做完、e2e 驗了排序與放下；音效要在真的裝置上聽到才勾，`DEPLOY.md` §5 第 16 步）
- [x] AC-5.4 — 圖片與檔案上傳（25 MB、黑名單）、縮圖與預覽、R2 24 小時後刪除有排程測試。（I5：`tests/worker/files.test.ts` 邊傳邊擋、黑名單、看內容、權限、標頭、配額；`tests/worker/backup.test.ts` 假時鐘的排程測試；`e2e/local/uploads.spec.ts` Alice 傳圖與檔、Bob 看到並下載、被擋的類型、鍵盤看圖、axe、手機；`scripts/abuse.ts` 在 PR 預覽經真的 R2。手機實測在 `DEPLOY.md` §5 第 28 步）
- [ ] AC-5.5 — 投票（單選／多選／匿名、即時結果、貼到聊天）；計時器與議程條全員可見。

## Task 拆分

### M0

- [x] `e5-t01` 聊天訊息模型、RoomDO 保留 200 則、速率限制、`chat.*` 訊息（協定 v8：`chat` 雙向、`rate_limited`；`shared/chat.ts`；每人每 10 秒 10 則、≤ 2000 字、去掉控制與雙向覆寫字元；每則一個 storage key，hibernation 後仍在；每次 `welcome` 後分段送歷史，重連也補上） · AC-5.1 · #18
- [x] `e5-t02` 聊天面板 UI：訊息列、輸入框、連結偵測、未讀數與氣泡預覽、手機抽屜（桌機 320 px 側欄、手機全螢幕 `Drawer`；Enter 送出、Shift+Enter 換行、輸入法選字不送（`compositionend` 後 200 ms 內的 Enter 也不送；觸控螢幕為主的裝置 Enter 換行、只有送出鈕送，2026-11-03 實測後修正）；只連 http／https、`rel="noopener noreferrer"`、純文字顯示；進房前的歷史不算未讀。AC-5.1 等 `DEPLOY.md` §5 第 11 步用手機實測） · AC-5.1 · #18

### M1

- [x] `e5-t03` 表情反應：訊息、浮出動畫、疊加、關閉顯示 · AC-5.2 · S · ← e5-t01, e4-t05 · #26（協定 v13 `react`／`reaction`；`shared/reactions.ts` 六種；權限表 `react`；每人每 5 秒 8 個，超過 RoomDO 不回錯誤直接丟；不存、後來的人看不到；同一人 1.5 秒內同一個反應合成一個泡泡「×N」，每格最多 4 個；`prefers-reduced-motion` 不浮動，改成靜止的徽章 2.5 秒；格子不在舞台上（隱藏自己、隱藏沒有視訊的人）時在舞台左下角顯示「名字 👍」；「更多 › 隱藏表情反應」記住）
- [x] `e5-t04` 舉手：狀態、名牌、面板排序、放下、音效 · AC-5.3 · S · ← e5-t03, e1-t08 · #26（`Member.hand` 是舉手時間（伺服器的時鐘），`handQueue` 依時間、同時依 id；`hand` 訊息（權限表 `raiseHand`，等候室的人不行）；主持人、共同主持人用 `host` `lowerHand` 放下比自己等級低的人的手，對方收到 `handLowered`；重連中保留、離開就沒了；**講話不會自動放下**（見未決問題）；主持人與共同主持人看到「<名字> 舉手了」與音效）
- [x] `e5-t05` 檔案上傳：一次性許可、經 Worker 串流到 R2（不用簽章直傳，上面「設計方向」有比較）、黑名單與看內容、25 MB、聊天內顯示（名稱、大小、類型）、進度條、取消、再試一次、配額、24 小時清除排程 · AC-5.4 · M · ← e5-t02, e11-t08 · I5（協定 v19 `ChatMessage.file`）
- [x] `e5-t06` 圖片縮圖（瀏覽器做）與 lightbox（lazy chunk；← → 換張、＋ − 縮放、Esc、焦點鎖在裡面、關閉後焦點回原處；手機滿版、可以雙指縮放）· AC-5.4 · S · ← e5-t05 · I5

### M2

- [ ] `e5-t07` 投票：建立、作答、即時結果、結束貼聊天 · M
- [ ] `e5-t08` 計時器與議程條 · S
- [ ] `e5-t09` 私訊（選用） · M

## 風險與對策

| 風險 | 對策 |
| --- | --- |
| 檔案上傳被濫用當免費空間 | 只有房內成員能拿簽章、24 小時刪、每房總量 200 MB |
| 反應動畫在手機吃效能 | CSS 動畫、同時最多 20 個、省電模式關閉（E6） |

## 未決問題

- **舉手不在開始講話時自動放下**（G3 決定，等擁有者確認）：講話偵測在每個瀏覽器自己做、會被咳嗽或背景聲觸發，自動放下會讓排隊的人莫名掉隊；Zoom 預設也不自動放下。要的話可以在 RoomDO 加「講話滿 N 秒放下」。

- [ ] **Q:** 持久房間的聊天要不要跨場保留？
      **A:** _(M2 再議)_
