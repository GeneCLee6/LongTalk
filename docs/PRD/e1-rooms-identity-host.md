---
title: E1 — 房間、身分與主持人控制
date: 2026-10-28
status: planned
epic: E1
owner: GeneCLee6
milestones: [M0, M1, M2, M3]
depends_on: [E11]
---

## 背景

「連結就是入口」是產品原則第一條（`00-prd.md` §5）。M0 的房間只要做到：按一下建房、連結貼給朋友、朋友輸入名字就進來、最後一人離開後房間自己消失。沒有帳號、沒有登入。

M1 開始對齊 Zoom 的主持人功能：鎖房、等候室、靜音他人、移出、共同主持人、結束會議；加上登入者才有的「固定房間連結」與「預定會議」。這些都是**權限**問題，所以 E1 同時負責角色模型與權限表（`roles.ts`），E2～E9 的任何「誰能做什麼」都查這張表。

## 目標

- 訪客 10 秒內進房（含輸入名字）；名字記在本機下次自動帶入。
- 房間生命週期由 RoomDO 的 alarm 控制：沒有時間上限，只有「空房 10 分鐘關閉」。
- M1：主持人能完整掌控房間；等候室與鎖房預設可用；登入者有固定房間與預定會議。
- 權限只在伺服器判斷，前端只呈現。

## 非目標

- 媒體軌的發布與訂閱（E2）；畫面與工具列（E4）。
- 多租戶、方案、付費（E11 AC-11.10）。
- 和淡江牌桌共用帳號（`00-prd.md` §14：建議不共用）。

## 需求

### 功能

- 房間 id：URL-safe 隨機 10 字元；`/r/<id>`。房間有名稱（預設「<建立者名字> 的房間」）。
- 成員：`id`、`name`、`role`（`host`、`cohost`、`participant`、`waiting`）、`sessionToken`（本機保存，重連與重新整理用）、連線狀態。
- 第一個進房的人是主持人；主持人離開 60 秒未回來，由最早進房的在線成員接手（M0）；M1 可指定共同主持人與移交主持人。
- 主持人控制（M1）：靜音某人／全員、關閉某人鏡頭、停止某人分享、移出（被移出者 10 分鐘內不能再進）、結束會議（全員離開、房間關閉）。
- 等候室（M1）：主持人開啟後新進者先在等候室；主持人逐一或全部放行、拒絕；等候者看得到「等待主持人放行」與自己的排序。
- 鎖房（M1）：鎖後任何人不能進（含等候室）；主持人可解鎖。
- 房間密碼（M1）：建房或房間設定可設 4–12 碼；連結可帶 `?pwd=`。
- 帳號（M1）：**只用通行密鑰（passkey）**（擁有者 2026-11-04 拍板：不做 Email magic link、不用第三方登入、沒有密碼）；登入者有 `/me`：個人固定房間（`/r/<自訂 slug>`）、預定會議清單、錄影清單（E8）。
- 預定會議（M1）：標題、時間、時長、房間；產生 `.ics` 與 Google／Outlook 日曆連結；時間到前房間就存在，不用提前開。

### 非功能

- 所有權限判斷集中在 `worker/roles.ts`，每個動作在 RoomDO 驗證並有測試。
- 房間 id 不可列舉；被移出的名單與密碼只存在 RoomDO。
- 空房關閉與移出期限用 `alarm()`；全部到期事件走同一個排程器。

## 設計方向

- `RoomDO` 的 `state`：`room`（id、name、createdAt、locked、waitingRoomEnabled、password hash、persistent）、`members`、`waiting`、`banned`、`tracks`（E2 寫入）、`chat`（E5 寫入）。
- 訊息協定放 `shared/protocol.ts`：客戶端→伺服器 `join`、`leave`、`rename`、`host.*`；伺服器→客戶端 `snapshot`、`patch`。
- 帳號用 Worker ＋ D1（或 SQLite DO）；不放進 RoomDO。固定房間是「`persistent: true` 且 id 由帳號擁有」的房間。I2：D1（`worker/account-db.ts`）＋ RoomDO 的 `persistent` 紀錄，見 `ARCHITECTURE.md` §5「帳號與固定會議室」。
- `.ics` 由 Worker 產生純文字；日曆連結用各家 URL 模板。

## 驗收條件

- [x] AC-1.1 — 首頁一鍵建房得到 `/r/<id>` 並自動進入；房間名稱可改；連結可一鍵複製；id 不可列舉。
- [ ] AC-1.2 — 點連結輸入名字即進房；名字與 session token 記在本機，重新整理後以同一身分回到房間；名字可在房內修改。
- [x] AC-1.3 — 房間沒有時間上限；最後一人離開 10 分鐘後房間關閉並清空狀態（持久房間保留設定）；主持人離線 60 秒由最早的在線成員接手。
- [ ] AC-1.4 — 主持人與共同主持人可靜音某人／全員、關閉某人鏡頭、停止某人分享、移出（10 分鐘內不能再進）、結束會議；每個動作被動者看得到提示；權限只在伺服器判斷並有測試。（F1 #22：主持人的部分與伺服器判斷、測試都有了；F3：共同主持人可以指定，能做的照權限表（結束會議只有主持人），e2e 裡共同主持人靜音別人。還不勾：媒體相關要兩台裝置實測，`DEPLOY.md` §5 第 12、15 步）
- [ ] AC-1.5 — 等候室開啟後新進者先等候，主持人逐一或全部放行、拒絕，等候者看得到排序；鎖房後任何人不能進；主持人可解鎖。
- [ ] AC-1.6 — ~~Email magic link 或~~ passkey 登入；登入者有個人固定房間連結（自訂 slug）與 `/me` 頁；訪客體驗不變。（I2 #38：擁有者拍板只用 passkey；程式、伺服器測試（錄下來的 Chromium passkey、軟體驗證器的三種演算法、真的 SQLite 跑 migration）與 e2e（Chromium 虛擬驗證器：註冊、登出、登入、建固定房、擁有者是主持人、匿名者是參與者、結束後設定還在、刪房、刪帳號）都有了。**還不勾**：要用實機的平台驗證器（iPhone Face ID、Mac Touch ID、Windows Hello、Android 螢幕鎖）註冊與登入、在第二台裝置新增通行密鑰、用手機掃 QR code 登入電腦，`DEPLOY.md` §5 第 26 步）
- [x] AC-1.7 — 登入者可建預定會議（標題、時間、時長），下載 `.ics` 或加入 Google／Outlook 日曆；時間到前房間已存在。（I3 #39：預定會議一定在擁有者的固定會議室裡，所以房間在會議前就存在；`.ics` 有 golden file 與讀回測試，e2e 在瀏覽器裡下載並解析；Google／Outlook 連結有網址測試。不涉及媒體，不需要兩台裝置。真的匯入 Google 日曆、Outlook、Apple 行事曆是擁有者的檢查，`DEPLOY.md` §5 第 27 步）
- [x] AC-1.8 — 房間可設 4–12 碼密碼；連結可帶密碼；錯三次要等 30 秒。（F3：伺服器測試與 e2e；不涉及媒體，不需要兩台裝置）

## Task 拆分

### M0

- [x] `e1-t01` Room 模型與短 id：`shared/protocol.ts` 的 `Room`／`Member`／訊息型別、id 產生器與測試 · AC-1.1 · #3
- [x] `e1-t02` 建房 API 與首頁「開一間房」按鈕：`POST /api/rooms` → RoomDO 初始化 → 導向 `/r/<id>` · AC-1.1 · #3
- [x] `e1-t03` 訪客加入：名字畫面、session token 存 localStorage、`join` 訊息、重新整理接回同一成員 · AC-1.2 · #5（實作：名字存 localStorage；token 存 sessionStorage，重新整理同一分頁接回，第二個分頁算新成員，不會搶走第一個分頁的身分）
- [x] `e1-t04` 房間生命週期：空房 10 分鐘 alarm 關閉、主持人離線 60 秒接手、統一排程器 · AC-1.3 · #14（`worker/scheduler.ts`：一個 alarm、多個到期工作 `sweep`／`close`／`handoff`；主持人主動離開時立即交接，斷線 60 秒才交接，回來後是一般成員）
- [x] `e1-t05` 房間名稱修改、連結複製與分享（Web Share API 有就用）、房內改名 · AC-1.1, AC-1.2 · #14（改房名暫定只有主持人，檢查在 RoomDO，F1 的 `roles.ts` 接手；預設房名「<第一位成員> 的房間」）

### M1

- [x] `e1-t06` 角色模型與權限表 `worker/roles.ts`（host／cohost／participant／waiting × 每個動作），測試覆蓋全表 · AC-1.4 · S · #22（表在 `shared/roles.ts`，瀏覽器只用它決定顯示哪些按鈕；判斷是 `worker/roles.ts` 的 `authorize`。25 個動作，含之後批次的列（等候室、密碼、共同主持人、舉手、標註、錄影、遠端控制），之後只要接上訊息、需要時改那一格。對某人的動作還要「對方的等級比自己低」：主持人 > 共同主持人 > 參與者 > 等候中，不能對自己。改房名、聊天、分享、SFU 媒體也改由這張表判斷）
- [x] `e1-t07` 主持人控制 API：靜音某人／全員、關鏡頭、停止分享、移出與 ban 名單（10 分鐘）、結束會議 · AC-1.4 · M · ← e1-t06 · #22（協定 v9 的 `host` 訊息。**靜音**與**關鏡頭**：RoomDO 立刻把那條軌標成 `muted`、送 `notice` 給本人，本人的瀏覽器自己關掉麥克風或鏡頭並顯示是誰做的；**沒有人能幫別人打開**，只有本人可以。全員靜音＝等級比自己低的每個人（主持人也會靜音共同主持人）。**移出**：以 4403 關掉對方的 socket，並把對方瀏覽器的 id（`join.client`，localStorage 裡的亂數）列入 10 分鐘的 ban 名單，存在 RoomDO storage，到期由排程器的 `bans` 工作清掉；**限制**：沒有帳號，私密視窗、換瀏覽器或清除網站資料就是新的 id，擋不住刻意回來的人（帳號在 I2、密碼與等候室在 F2／F3）。**結束會議**：只有主持人；全員以 4411 關閉、房間立即清空，之後 404）
- [x] `e1-t08` 參與者面板 UI：名單、每人的動作選單、全員靜音、被動者的提示 toast · AC-1.4 · M · ← e1-t07, e4-t06 · #22（桌機與聊天共用右側 `SidePanel`，上方「聊天｜參與者 N」切換；手機是全螢幕 `Drawer`，每人的選單是底部抽屜。名單：自己第一、再依角色與加入順序；名字首字、主持人／共同主持人／你、重新連線中、分享中、麥克風與鏡頭狀態。選單只列自己角色可做、而且會改變什麼的動作（開著的麥克風才有「靜音」）；移出與結束會議先確認。被動者的提示 toast 寫出是誰；被移出與會議結束是離開後畫面的兩種變化，沒有「重新加入」）
- [x] `e1-t09` 鎖房：狀態、API、鎖住時的進房畫面 · AC-1.5 · S · ← e1-t06 · #23（協定 v10 的 `host` `lock`（`on`），`RoomInfo.locked` 存在 RoomDO，大家看得到：頂部條房名後面一個鎖頭「已鎖定」。鎖住時 RoomDO 對**不認得的 token** 一律以 4423（`locked`）關掉，**連等候室也進不去**；寬限期內重新連線的成員（帶自己的 token）照樣回來，已經在等候室的人也還在、主持人照樣能放行。預先加入頁從 `GET /api/rooms/<id>` 就知道鎖了，直接顯示「這間會議室已鎖定」（不開鏡頭），「再試一次」重新查；在預先加入頁之後才鎖的，按加入後看到同一張畫面。誰能鎖：`lockRoom`（主持人、共同主持人））
- [x] `e1-t10` 等候室狀態機與 API：開關、進入等候、放行一人／全部、拒絕 · AC-1.5 · M · ← e1-t06 · #23（`host` `waitingRoom`（`on`）、`admit`、`admitAll`、`deny`，權限是 `waitingRoom`、`admit`（主持人、共同主持人）。等候室開著時新進者是角色 `waiting`：RoomDO 不送 `welcome`、不送房間狀態、patch 與聊天，只送 `lobby`（自己的 id 與 token、排第幾、共幾人、房名、現在有沒有能放行的人），有變化才再送；SFU 代理與 TURN 一律 403（`media`），聊天、分享、主持人控制都 `forbidden`。房裡的人在 `RoomView.waiting` 看到誰在等（先到先放）。**放行**：變成參與者（加入時間算放行那一刻）、送 `welcome` 與聊天歷史，同一個 socket 進房。**拒絕**：4406（`denied`）關掉、忘掉 token，這個瀏覽器 60 秒內再要求一律 4406（和移出的 ban 同一份名單，已有較長的 ban 不會被縮短）。**關掉等候室＝放行所有等候中的人**（不留人卡在已關的等候室；介面先問「放行 N 人並關閉」）。**等候 15 分鐘**沒被放行：排程器的 `waiting` 工作以 4412（`waitExpired`）請他離開。重新整理、斷線：寬限期內帶 token 回來，還是同一個排位。主持人離開：照 C2 交給最早進房、在線的**房內**成員（等候中的人永遠不會變主持人）；房裡一個人都不剩時沒有人能放行，等候中的人看到「主持人目前不在線上」，房間因為還有人在等而不關，最多 15 分鐘後等候逾時、房間變空、10 分鐘後關閉）
- [x] `e1-t11` 等候室 UI：主持人側的等候名單與通知、等候者側的等待畫面與排序 · AC-1.5 · M · ← e1-t10 · #23（**主持人側**：參與者面板上方「鎖定會議室」「等候室」兩個開關；有人在等時「等候中 N」一區，每人「拒絕」「放行」，兩人以上有「全部放行」；有人開始等時跳一則 toast（不出聲）「<名字> 在等候室，等你放行」，工具列「參與者」的徽章改成琥珀色、數的是等候人數。一般參與者看不到開關與等候名單（只看得到鎖頭）。**等候者側**：預先加入頁先說「這間會議室開了等候室」；加入後是等候畫面：房名、「你在等候室」、自己的鏡頭預覽（鏡像）與麥克風、鏡頭開關、「你是下一位」／「你排在第 N 位，共 M 人在等」、「主持人會讓你進來」（沒有能放行的人時改說主持人不在）、「離開等候室」；斷線時說正在重新連線。被放行時同一頁直接變成會議室，裝置是同一組、不用再輸入名字。被拒絕、等太久、鎖住、自己離開：各一張畫面，有「再試一次」「回首頁」，沒有評分（沒進過會議））
- [x] `e1-t12` 帳號：~~Email magic link（Resend 或 Cloudflare Email）或~~ passkey、D1 schema、`/me` 骨架 · AC-1.6 · #38（**擁有者 2026-11-04 拍板：只用通行密鑰（passkey，WebAuthn）**；不做 Email magic link、不用第三方登入服務、沒有密碼。**驗證**在 Worker 自己用 WebCrypto 做（`worker/webauthn.ts`＋`worker/cbor.ts`，沒有函式庫：`@simplewebauthn/server` 也能在 workerd 跑，但要帶 `@peculiar/*` 的 ASN.1／X.509 一串依賴，只為了我們不用的 attestation）：ES256、EdDSA（Ed25519）、RS256；要求可探索的憑證（resident key）與使用者驗證（`userVerification: required`），所以登入不用帳號名稱；attestation 要 `none`、不檢查（帳號從不取決於哪一種驗證器）。每次都檢查 type、challenge（Worker 發的、5 分鐘、只能用一次，存 D1 `challenges`，用完即刪）、origin、RP ID 雜湊、UP 與 UV 旗標、簽章、簽章計數器（同步型 passkey 一直是 0，照收；不是 0 又沒變大就拒絕）、使用者 handle 屬於同一個帳號。RP ID＝請求的網域（每個預覽是自己的 RP）。**D1**（`migrations/0001_accounts.sql`，正式 `longtalk`、所有預覽共用 `longtalk-preview`）：`accounts`（id＝WebAuthn user handle，16 bytes 亂數；顯示名稱；建立時間）、`credentials`（公鑰 COSE、演算法、計數器、transports、AAGUID、是否已同步、建立與上次使用時間）、`sessions`、`challenges`、`rooms`。**沒有 Email、沒有密碼、沒有 IP 或 user agent。****Session**：cookie `__Host-lt_session`（HttpOnly、Secure、SameSite=Lax、Path=/），內容是 32 bytes 亂數 token，D1 只存它的 SHA-256（不需要簽章 secret）；登入一律開新的 session（沒有 session fixation）；每天第一次使用時換新 token（舊的再用 2 分鐘，給已經在路上的請求）；30 天沒用或登入後 90 天到期；每帳號最多 20 個，再多踢掉最久沒用的。**CSRF**：SameSite=Lax 之外，所有非 GET 的 `/api/account/*` 都要 `Origin` 等於本站（沒有也拒絕；同一個 workers.dev 網站下的預覽也是別的 origin），有 body 的要 `application/json`。**濫用**：封鎖名單、每 isolate 的速率；GuardDO 每網路建帳號 1 小時 5 個、一天 20 個，開始登入 10 分鐘 30 次、一天 300 次（`shared/abuse.ts` `LIMITS`；碰到的網路在 `/admin` 是「帳號或登入太多」）；Turnstile 開著時建帳號也要過。**`/me`**（lazy，`src/pages/MePage.tsx`，WebAuthn 的瀏覽器端 `src/account/webauthn.ts` 也只在這個 chunk）：沒登入時「用通行密鑰登入」與「建立帳號」（顯示名稱＋這台裝置的通行密鑰）；登入後：名稱、固定會議室（`e1-t13`）、通行密鑰（AAGUID 認得的寫 iCloud 鑰匙圈、Google 密碼管理工具、Windows Hello…；建立與上次使用時間、是否同步；新增另一台裝置的、移除，最後一把不能移除）、登入中的瀏覽器（登出某一個、登出其他全部）、刪除帳號（帳號、通行密鑰、session、所有固定會議室一起刪；這台瀏覽器同時登出）。網站不認得的通行密鑰登入時回 `unknown_passkey`，瀏覽器呼叫 `PublicKeyCredential.signalUnknownCredential`（Chrome 132+）請密碼管理工具丟掉。首頁右上多一個「登入／我的帳號」連結（只看 localStorage 的提示，不打 API）；預先加入頁的名字欄先帶帳號的名字（`GET /api/rooms/<id>` 對登入的瀏覽器多回 `viewer`）。**不登入的一切照舊**。新能力 `passkeys` 進 `BROWSER-SUPPORT.md`）
- [x] `e1-t13` 個人固定房間：`persistent` 房間、自訂 slug、擁有者永遠是主持人 · AC-1.6 · #38（`/me`「建立固定會議室」：網址 `/r/<slug>`，slug 是 3–32 個小寫字母、數字、單一連字號，開頭是字母、結尾不是連字號；**全站唯一**、先到先得；保留字（`admin`、`api`、`me`、`support`、`longtalk`…，`shared/slug.ts`）不能用；**不能長得像隨機房號**（10 個 base58 字元），所以 slug 和隨機 id 永遠不會是同一個 Durable Object。每帳號最多 5 間；建立算一次 I1 的建房限制。D1 `rooms` 記 slug 屬於誰，設定存在那間房的 RoomDO（storage `persistent`＝slug、擁有者帳號 id；`RoomInfo.persistent` 給大家看，擁有者是誰不送出）。**擁有者怎麼被認出來**：不用簽章的 join ticket；瀏覽器的 WebSocket 升級本來就帶 session cookie，Worker 查 D1 得到帳號 id 後放進轉給 RoomDO 的 `x-longtalk-account` header（瀏覽器送來的同名 header 一律先刪掉；RoomDO 只有 Worker 摸得到），RoomDO 把它記在這個連線上。只有固定房間的升級會查 session。**擁有者永遠是主持人**：`join` 時擁有者跳過 ban、鎖房、密碼、等候室，直接變成主持人，原本的主持人變成共同主持人（並收到「…把你設為共同主持人」）；擁有者之後可以自己移交，重新整理或斷線回來時再拿回來。預先加入頁對擁有者不顯示鎖房畫面、密碼欄、等候室說明。**設定跨會議保留**（F3 留的註記）：結束會議或空房 10 分鐘時，只清掉這場會議（成員、聊天、ban、密碼猜錯紀錄、分享、聚光燈、**錄影狀態**（I4））；名稱、密碼、等候室、鎖定留著，房間不會消失（之後沒有任何 alarm）；結束後 10 分鐘內帶這場 token 回來的人還是看到「主持人已結束會議」，新開連結的人照常進。結束畫面對固定房間有「重新加入」。`/me` 列出每間房（名稱、連結、現在幾人、等候室／鎖定／密碼）：「進入」、「複製連結」、「設定」（名稱、等候室、鎖定、設定或清除密碼；在房裡的人立刻看到）、「刪除」（房裡的人以「會議已結束」離開、RoomDO 的資料全刪，之後 404，slug 可以被別人再用）。協定升到 **v18**（`RoomInfo.persistent`）
- [x] `e1-t14` 預定會議：模型、建立表單、`.ics` 產生、Google／Outlook 連結、`/me` 清單 · AC-1.7 · M · ← e1-t13 · #39（**模型**（D1 `migrations/0002_meetings.sql` 的 `meetings`）：id（16 bytes 亂數，也是公開頁 `/m/<id>` 的網址，猜不到）、擁有者、`room_slug`、標題（≤ 100 字）、說明（選填，≤ 1000 字，保留換行，去掉控制字元與雙向覆寫字元）、開始（UTC 毫秒）、時長（5 分鐘–24 小時）、`ends_at`、主辦人的 IANA 時區（瀏覽器的 `Intl` 時區，Worker 用 `Intl` 檢查並轉成標準名稱）、`sequence`（改幾次，`.ics` 的 SEQUENCE）、建立與修改時間。**連結＝擁有者的一間固定會議室**（`e1-t13`）：所以「時間到前房間已存在」一定成立；不另外保留房號。密碼與等候室**用那間房的設定**（RoomDO 是唯一真相，CLAUDE.md 規則 1），預定會議本身不存密碼或等候室；表單顯示那間房開了哪些、到「固定會議室 › 設定」改。沒有固定會議室時表單說先建一間。**只做單次會議**：AC-1.7 與 PRD F15 都沒有要求重複，所以沒有 RRULE（之後要做就加欄位與 RRULE）。**API**（`worker/accounts.ts`，和其他帳號呼叫一樣要登入、本站 `Origin`、JSON）：`POST /api/account/meetings`、`PUT /api/account/meetings/<id>`（整個會議再送一次）、`DELETE /api/account/meetings/<id>`；`GET /api/account` 多回 `meetings`。檢查在 `shared/meeting.ts`（`parseMeetingInput`，表單送出前用同一份）：開始不能早於現在 10 分鐘（兩邊時鐘差一點）、最多兩年後；**已經開始的會議改別的欄位時可以保留原本的開始**；房間必須是自己的固定會議室（別人的或不存在的一律 `meeting_invalid`／`room`）。**每一個改動都檢查擁有者**：別人的 id 和不存在一樣回 404（不透露存在）。每帳號最多 50 場（含保留中的過去會議，`too_many_meetings`）；建立與修改算 GuardDO 的 `meeting`（每網路 10 分鐘 30 次、一天 200 次，`shared/abuse.ts`）。**公開頁**（`GET /api/meetings/<id>`，`worker/meetings.ts`，不用登入；封鎖名單與每 isolate 速率照舊）：標題、說明、時間、時區、`sequence`，**主辦人只給顯示名稱**（不給帳號 id）；房間 slug **從開始前 15 分鐘起才給**（`MEETING_JOIN_EARLY_MS`），之後一直給（固定會議室結束後也在）。`/m/<id>`（`src/pages/MeetingPage.tsx`，lazy，不含帳號 API 與 WebAuthn）：你的時間（瀏覽器時區）＋主辦人的時間（時區不同時）、時區名稱與 GMT 偏移（`Intl` 的 `longGeneric`＋`shortOffset`，跟著夏令時間）、倒數、「加入會議」**開始前 15 分鐘才能按**（開著頁面等到時間會自己再問一次 Worker 拿房間），之後一直能按；`.ics` 與日曆連結。**`/me`「預定會議」**（`src/pages/MeetingsCard.tsx`）：接下來（最近的在上）與「已結束」（摺疊，寫 90 天後刪除）；新增與編輯表單（手機友善：`<input type="date">`、`<input type="time">`、時長下拉；寫出用的是哪個時區，**時間以這個瀏覽器的時區為準**，存檔時時區也換成這個瀏覽器的）；邀請頁、複製邀請（主題、主辦人時區的時間、`/m/<id>` 連結、說明；**房間有密碼時先問要不要附上**，要的話當場輸入、只放進這次複製的文字、不存）、編輯、刪除（先確認）。**`.ics`**（`shared/ics.ts`，在瀏覽器產生並下載，不經伺服器）：RFC 5545，CRLF、75 位元組摺行（不切斷 UTF-8 字元或表情符號）、TEXT 跳脫 `\ ; , 換行`，`VERSION`、`PRODID`、`METHOD:PUBLISH`、`UID`（`<id>@<網域>`，改時間後匯入是更新不是多一個）、`DTSTAMP`（最後修改）、`SEQUENCE`、`DTSTART`／`DTEND`（UTC `Z`，不需要 VTIMEZONE）、`SUMMARY`、`DESCRIPTION`（說明＋「加入會議：連結」）、`URL` 與 `LOCATION`（`/m/<id>`）。**日曆連結**（`shared/calendar-links.ts`）：Google 日曆（`render?action=TEMPLATE`，帶 `ctz` 主辦人時區）、Outlook.com 與 Outlook（公司或學校，`outlook.office.com`）的 deeplink，都是新分頁、`rel="noopener noreferrer"`。**刪除與保留**：刪固定會議室時它的預定會議一起刪（確認文字有寫）；刪帳號全部刪；**結束 90 天後**（`MEETING_RETENTION_MS`）`/me` 與公開頁都看不到，下一次任何人儲存預定會議時真的刪掉（e11「帳號資料」）。不寄提醒信（沒有 Email）。**測試**：`tests/shared/ics.test.ts`（兩個 golden file `tests/shared/fixtures/*.ics` 逐位元組比對、讀回每個值、摺行與跳脫）、`tests/shared/meeting.test.ts`（檢查規則、時區、加入時間窗、Google／Outlook 網址）、`tests/worker/meetings.test.ts`（真的 SQLite：每個欄位的檢查、擁有者、GuardDO、上限、公開頁只給名字與時間窗、保留與連鎖刪除、0002 套在已有 I2 資料的 0001 上與外鍵）、`tests/app/meetings.test.tsx`（`Intl` 的時區與夏令時間、邀請文字、`.ics`、`/me` 表單、複製邀請含不含密碼、`/m/<id>`）；`e2e/local/meetings.spec.ts`（vite preview＋本機 D1，Chromium 虛擬驗證器：註冊、建固定房、預定 5 分鐘後的會議、另一個時區的匿名瀏覽器開 `/m/<id>`、下載 `.ics` 並讀回、進房、刪帳號後 404）；a11y 掃 `/me` 的表單與清單、`/m/<id>`、找不到）
- [x] `e1-t15` 房間密碼：設定、驗證、`?pwd=`、錯三次等 30 秒 · AC-1.8 · S · ← e1-t06 · F3（協定 v12 的 `host` `setPassword`（`password`，null 清除），權限 `setPassword` 只有主持人。RoomDO 只存**加鹽的 SHA-256**（每次設定 16 bytes 新的鹽，storage `password`），以固定時間比對；不用 PBKDF2 這類慢雜湊，因為 4–12 碼的密碼擋不住離線窮舉，慢雜湊只會讓每次加入多花 CPU，真正的保護是線上猜的次數限制。大家只看得到 `RoomInfo.passwordSetAt`（何時設的，null＝沒有）。新進者在 `join` 訊息裡帶密碼（**不放進任何 URL**），檢查順序：ban → 認得的 token（寬限期內回來的成員、已在等候的人：不再問密碼）→ 鎖房（鎖住時不透露密碼對不對，也不算一次猜錯）→ 密碼 → 等候室。沒帶 4401、錯 4402；同一個瀏覽器 id **或**同一個網路位址（`CF-Connecting-IP` 和房號一起雜湊後才存）連錯 3 次，兩者都要等 30 秒（4429，原因欄是剩幾毫秒），存在 storage（`guesses`，排程器 `guesses` 工作清掉），10 分鐘前的錯誤不再算。主持人改密碼時，正在比對舊密碼的那一次算錯（不計次）。**瀏覽器**：連結的 `?pwd=` 在 `main.tsx` 一開始就讀走並以 `history.replaceState` 從網址列拿掉（不留在歷史、不當 Referer、遙測看不到；錯誤訊息的 `pwd=` 也會被遮掉）；預先加入頁看到房間有密碼就多一欄（從連結帶入時寫「已從連結帶入密碼」），錯了回到預先加入頁說「密碼不對」，錯太多次倒數 30 秒、加入鍵停用。這個分頁知道的密碼存在 sessionStorage（和 session token 同一處），用來給「更多 › 複製含密碼的連結」；頂部條的「複製連結」是不含密碼的（有密碼時提示對方要輸入）。主持人在參與者面板「會議室設定」的「會議室密碼」設定、變更、清除；已在房裡或在等候的人不受影響）
- [x] `e1-t16` 共同主持人指定與主持人移交 · AC-1.4 · S · ← e1-t07 · F3（`host` `setCohost`（`memberId`、`on`）與 `makeHost`（`memberId`），權限 `setCohost`／`makeHost` 只有主持人、不能對自己、不能對等候中的人；移交只給在線的人，**前主持人變成共同主持人**。被指定的人先收到 `notice`（`madeCohost`、`cohostRevoked`、`madeHost`）再收到改角色的 patch，畫面跳 toast 寫是誰做的。共同主持人能做的照 F1 的權限表：除了結束會議、設密碼、指定共同主持人、移交主持人、錄影，其餘和主持人一樣。主持人離開或斷線 60 秒時，**先交給最早進房、在線的共同主持人**，沒有才是最早進房的在線成員。介面：主持人在每人的 ⋯ 選單有「設為／取消共同主持人」「設為主持人」（先確認）
- [x] `e1-t17` 結束會議流程：全員看到結束畫面、房間立即關閉、持久房間保留設定 · AC-1.4 · S · ← e1-t07（F1 #22：參與者面板「結束會議」、全員看到「主持人已結束會議」、房間立即關閉。F3：主持人按「離開」（房裡還有別人在線時）先問：「只有我離開」（下拉選誰接手，預設是房間自己會選的人：共同主持人優先、再來最早進房的；`leave.host`）或「結束會議（所有人）」；自己結束的人看到「你已結束會議」。結束後 RoomDO 留一個 10 分鐘的**墓碑**（storage `ended`，排程器 `ended` 工作清掉）：當時正在重新連線的人回來是 4411「主持人已結束會議」，不再是「這間會議室已經關閉」；這段時間這個 id 也不會被重新建房。**持久房間保留設定**要等持久房間本身（`e1-t13`），到時候結束會議只清成員與聊天、留下設定。I2 #38：做了，見 `e1-t13`）

### M2

- [ ] `e1-t18` 房間設定頁（持久房間）：預設等候室、預設靜音進房、允許標註、允許錄影 · M

### M3

- [ ] `e1-t19` 多租戶下的帳號與房間配額（與 E11 `e11-t11` 一起） · M

## 風險與對策

| 風險 | 對策 |
| --- | --- |
| 主持人斷線時房間失控 | 60 秒自動接手；共同主持人（M1） |
| 房間 id 被猜到 | 59 bits 隨機 ＋ 鎖房／等候室／密碼；建房有速率限制（E11） |
| 通行密鑰全部遺失（換手機、清掉密碼管理工具） | 一個帳號可以有多把（`/me` 在另一台裝置新增）；同步型 passkey（iCloud、Google）跟著那個帳號走；**沒有 Email 就沒有找回流程**：全部遺失只能重建帳號、重新建固定房間（I2 的取捨，擁有者拍板） |

## 未決問題

- [x] **Q:** 帳號登入方式：magic link、passkey、還是兩者？
      **A:** 2026-11-04 擁有者拍板：**只用 passkey**（WebAuthn），沒有 Email、沒有密碼、沒有第三方登入服務（I2 #38）。
- [x] **Q:** 固定房間的 slug 要不要全站唯一（`/r/gene`）？
      **A:** I2 #38 做成**全站唯一、先到先得**（`/r/gene`），加保留字與「不能長得像隨機房號」；擁有者可推翻（改成 `/r/<帳號>/<slug>` 要動路由與 DO 命名）。
