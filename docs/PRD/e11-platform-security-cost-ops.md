---
title: E11 — 平台、安全、成本與維運
date: 2026-10-28
status: planned
epic: E11
owner: GeneCLee6
milestones: [M0, M1, M2, M3]
depends_on: []
---

## 背景

所有 epic 的地基：repo、CI、部署、遙測、安全、成本。對一個「免費替代 Zoom」的產品，**成本可見與自動降級**本身就是功能；對一個會錄影、能遠端控制的產品，**法遵與濫用防護**不能等到出事才做。

## 目標

- M0：repo 骨架、CI、Pages＋Workers 部署、最小遙測（錯誤、連線成功率）、瀏覽器支援文件。
- M1：建房速率限制與 Turnstile、安全標頭與 CSP、錄影法遵清單與隱私頁、R2 清除排程與備份。
- M2–M3：成本儀表板與自動降級、E2EE 研究、多租戶與方案、負載與混沌測試。

## 非目標

- 企業合規認證（SOC 2 等）。

## 需求

- Repo：Vite＋React 19＋TS strict＋styled-components；`worker/`（Hono 或原生）＋ `wrangler.toml`；`shared/`；Vitest；Playwright；oxlint；`npm run budget` 效能預算（首頁 150 kB、會議室 350 kB）。
- CI：lint、typecheck、test、build、budget、視覺回歸（M1）；PR 預覽部署；合併 `main` 自動部署；兩個環境（preview、production）。
- 遙測：事件（進房成功／失敗原因、重連次數、TURN 比例、離開評分）送 Analytics Engine 或 D1；錯誤送 Sentry 類（自架或免費方案）；儀表板頁 `/admin`（擁有者）。D3 起：自架，事件與錯誤都進 `/api/events`（`TelemetryDO` 計數＋Analytics Engine），`/admin` 以 `ADMIN_TOKEN` 保護（`DEPLOY.md` §8）。
- 瀏覽器支援：`docs/BROWSER-SUPPORT.md` 每功能 × 瀏覽器矩陣；`src/media/capabilities.ts` 統一能力偵測。
- 濫用防護：建房每 IP 每小時 10 間、Turnstile 於建房、WebSocket 訊息速率、上傳配額；黑名單 IP。
- 安全：CSP、HSTS、Permissions-Policy（camera、microphone、display-capture 只給自己）、COOP；依賴稽核；secrets 只在 Worker。
- 法遵：錄影同意、隱私權政策頁、資料保留表（聊天 24 小時、錄影 7–30 天、遙測 90 天）、個資法檢查清單、刪除請求流程。（I6 定案：`/privacy` 照程式寫，聊天是「會議關閉時刪除」、不是 24 小時；只有本機錄影；不宣稱符合任何法律，法律問題列給擁有者找律師，見 `NEXT.md`。）
- 清除與備份：R2 到期刪除排程（cron trigger）；D1 每日匯出到 R2（I5 定案 7 天，不是 30 天）。
- 成本儀表板（M3）：Realtime、TURN、R2、Workers 用量 API 或估算；月預算；超額自動降級順序（關雲端錄影→限 HD→降最高層→限人數）；告警 Email。
- E2EE 研究（M2）：Insertable Streams／SFrame 可行性、對錄影與標註的影響；輸出 ADR。
- 多租戶（M3）：帳號配額、方案（免費／贊助）、擁有者後台。
- 測試：負載（E10 腳本）、混沌（殺 DO、斷 SFU、TURN 不可達）演練清單。

## 設計方向

- 複製淡江牌桌的 CI、效能預算腳本、`scripts/load/` 手法；不共用程式碼 repo。
- `/admin` 只給擁有者帳號；儀表板資料從 Analytics Engine SQL API 讀。D3 的骨架改讀 `TelemetryDO` 的計數（不需要另外的 Cloudflare API token），帳號登入前以 Worker secret `ADMIN_TOKEN` 保護；Analytics Engine SQL 留給細查。

### 帳號資料（I2，`e1-t12`、`e1-t13`；I3 `e1-t14`；隱私權政策頁 `e11-t07` 照這張寫）

帳號是選用的，只用通行密鑰（passkey）：**沒有 Email、沒有密碼、沒有電話**。D1（`migrations/0001_accounts.sql`、`0002_meetings.sql`）存的就是下面這些，沒有別的：

| 資料 | 內容 | 保留多久 |
| --- | --- | --- |
| 帳號 | 隨機 id（也是 WebAuthn 的 user handle）、顯示名稱、建立時間 | 到使用者刪除帳號 |
| 通行密鑰 | credential id、公鑰（不是私鑰：私鑰一直在使用者的裝置或密碼管理工具）、演算法、簽章計數器、transports、AAGUID（驗證器型號的公開 id，只用來在 `/me` 寫「iCloud 鑰匙圈」這類名字）、是否已同步、建立與上次使用時間 | 到使用者移除那把或刪除帳號 |
| 登入的瀏覽器（session） | 隨機 id、token 的 SHA-256（不是 token）、建立、上次使用、到期時間；**不記 IP、不記瀏覽器或裝置** | 30 天沒用、登入後 90 天、登出、被「登出其他」或刪帳號時刪除；過期的在下一次有人登入時清掉 |
| 登入用的 challenge | 隨機值、種類、（註冊時）準備給新帳號的 id 與名字 | 用掉就刪；沒用的 5 分鐘後過期，下一次有人要 challenge 時清掉 |
| 固定會議室 | slug、擁有者帳號 id、建立時間（D1）；名稱、密碼的加鹽雜湊、等候室、鎖定（那間房的 RoomDO） | 到擁有者刪除那間房或帳號；會議本身的資料（成員、聊天、錄影狀態）在會議結束或空房 10 分鐘時清掉，和隨機會議室一樣 |
| 預定會議（I3） | 隨機 id（公開頁 `/m/<id>`）、擁有者帳號 id、用哪間固定會議室、標題、說明、開始時間、時長、結束時間、主辦人的時區（IANA 名稱，例如 `Asia/Taipei`）、修改次數、建立與修改時間；**不存與會者、Email、密碼**。拿到連結的人看得到標題、說明、時間、時區與擁有者的**顯示名稱**（開始前 15 分鐘起還有固定會議室的網址） | 到擁有者刪除那場、那間固定會議室或帳號；否則**會議結束 90 天後**（`MEETING_RETENTION_MS`）：從那時起 `/me` 與公開頁都看不到，下一次有人儲存預定會議時從 D1 刪掉。下載的 `.ics` 與加進別人日曆的活動在對方那裡，網站刪不到 |

| 分享上的標註（J2） | 筆跡、文字、畫的人（成員 id）；存在 RoomDO，約每 5 秒批次寫入；雷射筆不存 | 分享停止或會議結束時刪除 |
| 固定會議室的白板（J4） | 筆跡與文字，**不存畫的人**（R2，`boards/<slug>/<建立時間>.json`，算進 2 GB） | 下一場會議接著用，沒有固定期限；有人清除、房間或帳號刪除時一起刪；當下刪除失敗，每小時的 sweep 比對 D1 補刪。24 小時的規則不適用 |
| 聊天裡的檔案（I5） | 檔案內容（R2，`uploads/<小時>/<id>`）、瀏覽器做的縮圖；RoomDO 記檔名、大小、類型、誰傳的（成員 id，不是帳號）、到期時間。**不記 IP**（每個網路的上傳次數只存雜湊，在 `GuardDO`）。圖片的 EXIF（可能有定位）照原樣保留在原檔，縮圖沒有 | **最多 24 小時**：滿 24 小時（從開始上傳算）就下載不到，每小時的 Cron 在 24–25 小時之間刪除；房間關閉時當場刪除 |
| D1 每日備份（I5，`longtalk-backups`） | `accounts`、`credentials`（公鑰）、`rooms`、`meetings` 的完整內容，gzip 的 JSON lines（`d1/<日期>.jsonl.gz`）；**不含** `sessions`（只有雜湊也不留）與 `challenges`。沒有另外加密（靠 R2 的靜態加密），只有擁有者的 Cloudflare 帳號拿得到 | **7 天**（`BACKUP_RETENTION_DAYS`）：每天的備份寫好後刪掉超過 7 天的 |

**刪除帳號**（`/me`，`DELETE /api/account`）：先刪每一間固定會議室的 RoomDO 資料（正在裡面的人看到會議結束），再刪 D1 裡這個帳號的所有列（預定會議、帳號、通行密鑰、session、challenge、固定會議室），這台瀏覽器同時登出；**每日備份裡還留著最多 7 天**（I5，`e11-t08`）：刪除當下不會去改舊備份，7 天後最後一份含這個帳號的備份被刪掉，資料才完全不存在。從備份還原時，還原點之後刪掉的帳號會**回來**：`DEPLOY.md` §12 的還原步驟要求還原後再處理這段期間的刪除請求（隱私權政策頁 `e11-t07` 要照這段寫）。使用者裝置裡的通行密鑰網站刪不到：`/me` 提醒自己刪，Chrome 132+ 用那把登入時會收到 `signalUnknownCredential` 並移除。遙測（`TelemetryDO`）不記帳號 id。

## 驗收條件

- [x] AC-11.1 — Workers（帶靜態資產）＋DO 部署；preview 與 production；合併 `main` 自動上線；`DEPLOY.md`。（2026-10-31 驗證：正式站 https://longtalk.genelee-pro.workers.dev 由 Deploy workflow 部署、smoke test 通過；PR 預覽見 #6）
- [ ] AC-11.2 — CI：lint、typecheck、test、build、budget 全綠才可合併；M1 加視覺回歸與 Lighthouse。（M0 部分 2026-10-31 完成：`main` 受保護，`CI / verify` 必過、禁止 force-push、管理員同樣受限；M1 部分等 `e4-t14`、`e4-t17`）
- [ ] AC-11.3 — 進房成功率、失敗原因、重連、TURN 比例、評分可在 `/admin` 看；錯誤有告警。（D4 起評分也在 `/admin`：平均與 1–5 分分布，`e4-t18`。還不勾：告警只是 `/admin` 上的紅字旗標，不會主動通知，主動通知在 `e11-t09`）
- [ ] AC-11.4 — 成本儀表板：各項用量與預估費用、月預算、自動降級可演練、告警。
- [x] AC-11.5 — 建房速率限制與 Turnstile、訊息速率、上傳配額、IP 黑名單；濫用測試。（I1 #36 做了上傳配額以外的全部；I5 補上上傳配額：每位成員、每間房、每個網路、全站 2 GB，`scripts/abuse.ts` 加了上傳的檢查。正式站的 Turnstile 程式已經在，只等擁有者設定 key，`DEPLOY.md` §11）
- [x] AC-11.6 — `BROWSER-SUPPORT.md` 完整且與 `capabilities.ts` 一致。（H6 #35：18 項能力 × 6 個瀏覽器全部有記號與退路；一致性兩道檢查：`tests/app/media/capabilities.test.ts` 比對列、順序、欄位與記號，`e2e/local/browsers.spec.ts` 在 Chromium、Firefox、WebKit 裡跑 app 自己的偵測和 Chrome、Firefox、Safari 欄比對。實機的 ● 是 AC-2.8 的事）
- [x] AC-11.7 — CSP、HSTS、Permissions-Policy、COOP；`npm audit` 無高風險；secrets 不進前端（lint 擋）。（I1 #36：`public/_headers`＝`shared/security-headers.ts`；CI 的 `npm audit --omit=dev --audit-level=high`；`scripts/secrets.ts` 在 lint 與 budget）
- [x] AC-11.8 — 隱私權政策頁、資料保留表、錄影同意清單、刪除請求流程；R2 到期刪除與 D1 備份有排程測試。（I5 #40 做完後半句：R2 到期刪除、D1 備份、還原演練都有假時鐘的排程測試。I6 #43 做完前半句：`/privacy` 繁中與英文，保留表的數字直接讀常數、常數變了測試失敗；同意清單在頁面與 `e8` 文件；刪除請求：登入者在 `/me`，其他人照 `shared/privacy.ts` 的 `PRIVACY_CONTACT`，擁有者的步驟在 `DEPLOY.md` §13。這條勾的是「這些東西都有」，**不代表**法律上已經審過：律師要看的問題在 `NEXT.md`）
- [x] AC-11.9 — E2EE 可行性 ADR。（O2 #PR：`docs/adr-002-e2ee.md`。結論：在 Realtime 上做得到（Cloudflare 的 Orange Meets 已經這樣做、SFU 不用改），但只給朋友用、擁有者自己維運，多擋的只有 Cloudflare 的機器，代價是相容性與雲端錄影類功能，所以**現在不做**；寫了觸發條件與一天的 spike 步驟。不涉及媒體實作，不用兩台裝置）
- [ ] AC-11.10 — 多租戶：帳號配額、方案、擁有者後台。
- [x] AC-11.11 — **只用免費額度**：Realtime（SFU＋TURN）每月流出有計數；達 800 GB 新連線預設低畫質、達 950 GB 不再建立新的視訊 session（只留音訊）、每月 1 日歸零；門檻可設定、有測試、`/api/usage` 可查。

## Task 拆分

### M0

- [x] `e11-t01` repo 骨架：Vite／React／TS、`worker/`、`shared/`、wrangler、Vitest、oxlint、`CLAUDE.md`／`RULES.md` · AC-11.1 · #2
- [x] `e11-t02` CI（lint、typecheck、test、build、budget）、PR 預覽 Worker 與 production 部署、`DEPLOY.md` · AC-11.1, AC-11.2 · #2
- [x] `e11-t03` 最小遙測：事件 API、Analytics Engine、錯誤回報、`/admin` 骨架（`POST /api/events` 驗證、8 KB、每個 IP 雜湊的速率限制；`TelemetryDO` 每小時／每天計數與最近錯誤；Analytics Engine 綁定 `EVENTS`（程式支援；帳號啟用 Analytics Engine 前先註解掉，`DEPLOY.md` §8）；未攔截錯誤去重、上限、去個資；`/admin` lazy、`ADMIN_TOKEN` 標頭＋常數時間比對；警示是 `/admin` 上的旗標。AC-11.3 不勾：評分是 D4 `e4-t18`，告警還不會主動通知） · AC-11.3 · #18
- [x] `e11-t04` `BROWSER-SUPPORT.md` 初版與 `capabilities.ts`（`docs/BROWSER-SUPPORT.md`：8 項能力 × 6 個瀏覽器，實測過的才標 ●，其餘標「未實測」；`src/media/capabilities.ts`：`webrtc`、`getUserMedia`、`getDisplayMedia`、`setSinkId`、`replaceTrack`、`senderParameters`、`audioContext`、`deviceChange`，會議室頁與音量表改用它；測試比對文件表格與 `CAPABILITIES`。AC-11.6 不勾：Edge、Firefox、Safari、iOS Safari 都還沒實測，完整版是 `e2-t16`） · AC-11.6 · #11
- [x] `e11-t13` Realtime 免費額度保護：`UsageDO` 每月流量計數（客戶端 `getStats` 回報與伺服器端以 session 時長×軌數估算取大者）、800 GB 降畫質、950 GB 拒絕新視訊 session、`/api/usage`（2026-10-31 擁有者決定只用免費方案；`e11-t09` 成本儀表板之後接這份計數；做法見 `DEPLOY.md` §6） · AC-11.11 · #8

### M1

- [x] `e11-t05` 濫用防護：建房速率、Turnstile、訊息速率、IP 黑名單（全站一個 `GuardDO`：每個網路（IPv4、IPv6 /64，只存雜湊，可選 `IP_HASH_PEPPER`）建房 10 分鐘 10 間、一天 60 間；Turnstile 在兩把 key 都設了才開，Worker 打 siteverify；封鎖名單有到期、`/admin` 管理，`/api/rooms/*` 一律 403；RoomDO 每房每網路每分鐘 60 次升級、每連線 10 秒 120 個訊息，超過 4420，超大訊息 1009；協定 v16；`scripts/abuse.ts` 在每個 PR 預覽跑） · AC-11.5 · #36
- [x] `e11-t06` 安全標頭、CSP、Permissions-Policy、secrets lint、依賴稽核進 CI（CSP 回報進遙測；`e2e/local/security.spec.ts` 確認 RNNoise、service worker、喇叭測試、`/admin` 在 CSP 下都正常） · AC-11.7 · #36
- [x] `e11-t07` 法遵：隱私權政策頁、資料保留表、錄影同意清單、刪除請求（`/privacy` lazy，文字每種語言一個 lazy 模組；`src/privacy/facts.ts` 讀常數；`DEPLOY.md` §13；`e8` 的同意清單）· AC-11.8 · S · ← e8-t02 · I6 #43
- [x] `e11-t08` R2 到期刪除 cron、D1 每日備份到 R2、還原演練（Cron 每小時一次，正式站才有；`FileLedgerDO` 記帳與校正；gzip 的 JSON lines、保留 7 天、不含 session；`scripts/restore-backup.ts` 與 `DEPLOY.md` §12 的還原步驟；演練在 `tests/worker/backup.test.ts`，每次提交都跑）· AC-11.8 · S · ← e11-t02 · I5

### M2

- [ ] `e11-t09` 成本儀表板：用量 API／估算、月預算、自動降級、告警 · AC-11.4 · M · ← e11-t03

### M3

- [x] `e11-t10` E2EE 可行性研究 ADR（`docs/adr-002-e2ee.md`：威脅模型、Encoded Transform 的瀏覽器支援、對錄影／標註／白板／代理／分組的影響、金鑰怎麼發的三個選項；決定現在不做，觸發條件與 spike 步驟） · AC-11.9 · S · O2 #PR
- [ ] `e11-t11` 多租戶：配額、方案、擁有者後台（與 E1 `e1-t19`） · AC-11.10 · M · ← e1-t12
- [x] `e11-t12` 混沌演練清單與執行（殺 DO、斷 SFU、TURN 不可達）（`DEPLOY.md` §14 八項清單；`tests/worker/chaos.test.ts` 每次提交跑、`e2e/chaos.spec.ts` 每個 PR 預覽跑；預覽才有的 `POST /api/chaos/rooms/<id>/kill`（`worker/chaos.ts`，`CHAOS_DRILLS`）；演練找到並修掉：SFU 與 TURN 的 API 卡住時沒有逾時（Worker 10 秒／5 秒、瀏覽器等 ICE 6 秒）。前提 `e10-t03` 跟著 L2 跳過，負載部分沒做。AC-11.3 不勾：告警還是只有 `/admin` 的旗標） · AC-11.3 · S · O2 #PR

## 風險與對策

| 風險 | 對策 |
| --- | --- |
| 免費額度政策變動 | 儀表板早於擴張；降級順序先寫好 |
| 被拿去當匿名騷擾工具 | 速率限制、Turnstile、檢舉連結、IP 黑名單 |

## 未決問題

- [x] **Q:** 錯誤回報用 Sentry 免費方案還是自架？
      **A:** 自架，不開第三方帳號（不用 Sentry），只用免費額度（擁有者 2026-11-02 決定）。錯誤與事件送自己的 `POST /api/events`，計數在 `TelemetryDO`、明細進 Workers Analytics Engine，`/admin` 看；做法見 `DEPLOY.md` §8（#18）。
