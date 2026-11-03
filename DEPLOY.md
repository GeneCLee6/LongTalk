# DEPLOY — 部署

LongTalk 是**一個 Cloudflare Worker**：同一個 Worker 回答 `/api/*`、承載 Durable Object（每房一個 `RoomDO`，加上全站各一個的 `UsageDO`、`TelemetryDO`），其餘路徑交給靜態資產（React app，`dist/client`）。

## 為什麼是 Workers Static Assets，而不是 Pages ＋ 另一個 Worker

規劃時寫的是「Pages（前端）＋ Workers（API）」。A1 改成一個 Worker 帶靜態資產，理由：

- Durable Object 只能由 Worker 定義；Pages Functions 要綁 DO 必須另開一個 Worker 再跨 script 綁定，部署兩個東西、版本會錯開。
- 一個 Worker 一次部署：前端與 API 永遠是同一個 commit（`/api/health` 與 `<meta name="app-version">` 會一致，smoke test 就是查這個）。
- PR 預覽：每個 PR 部署成自己的 Worker（`longtalk-pr-<號>`），有自己的 DO 儲存，不會碰到正式站的房間。Pages 的預覽網址無法給有 DO 的 Worker 用。
- 和淡江牌桌同一套做法，已經跑過。

功能上對使用者沒有差別；之後要掛自訂網域，在 Worker 加 route 即可。

## 1. 第一次設定（只做一次）

1. Cloudflare 帳號（免費方案即可；Durable Object 用 SQLite 版，免費方案可用）。
2. 本機登入並試部署：

   ```sh
   npm ci
   npx wrangler login
   npm run deploy          # build + wrangler deploy，第一次會建立 longtalk Worker
   ```

   部署完會印出 `https://longtalk.<子網域>.workers.dev`。
3. 在 GitHub repo 設定兩個 secret（Settings → Secrets and variables → Actions）：

   | Secret | 從哪裡拿 |
   | --- | --- |
   | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 儀表板右側欄「Account ID」，或 `npx wrangler whoami` |
   | `CLOUDFLARE_API_TOKEN` | 儀表板 → My Profile → API Tokens → Create Token → 範本「Edit Cloudflare Workers」 |

   ```sh
   gh secret set CLOUDFLARE_ACCOUNT_ID
   gh secret set CLOUDFLARE_API_TOKEN
   ```

   **沒設定 secret 時，部署與預覽的 workflow 會跳過（notice，不是失敗）**，CI 照跑。

## 2. 自動部署（CI/CD）

| Workflow | 何時 | 做什麼 |
| --- | --- | --- |
| `ci.yml` | 每次 push、每個 PR | `npm ci` → 相依稽核（正式相依 high／critical 失敗，§11）→ lint（含 secrets lint）→ typecheck → test → build → JS 預算（首頁 ≤ 150 kB、會議室 ≤ 350 kB gzip）與 build 出來的檔案沒有 secret。全綠才可合併（AC-11.2） |
| `preview.yml` | PR 開啟、更新 | 部署 `longtalk-pr-<號>`（`CLOUDFLARE_ENV=preview`），smoke test，把網址留言在 PR；接著 `e2e` job 在這個預覽跑三個瀏覽器的互通測試（§7），之後 `abuse` job 對預覽跑濫用測試（§11）；PR 關閉時刪除該 Worker 與它的資料 |
| `ui.yml`（`UI checks`） | 每個 PR、`main` 的 push、手動 | 在 Playwright 的 Docker image 裡 build＋`vite preview`：`a11y`（axe 與鍵盤、Lighthouse 無障礙 ≥ 0.95）、`visual`（12 張基準截圖）；不是必過的檢查（§7） |
| `deploy.yml` | CI 在 `main` 綠了之後 | 部署正式站 `longtalk`，smoke test 確認它正在提供這個 commit |

smoke test（`scripts/smoke.sh`）檢查：首頁 `<meta name="app-version">` 是這個 commit、`/api/health` 回這個 commit、`/r/<id>` 回 200（SPA fallback）、品牌檔案（§9），以及 `/sw.js` 是 JavaScript、`Cache-Control: no-cache`、`appVersion` 是這個 commit、預先快取清單裡沒有 `/api`（§10），首頁與 `/api/health` 帶著安全標頭（§11）。

建議在 GitHub 把 `main` 設為受保護分支：要求 PR、要求 `CI / verify` 通過。

### 手動部署

- 正式站：Actions → Deploy → Run workflow（部署 `main` 最新的 commit），或本機 `npm run deploy`。
- 某個分支：開 PR 就有預覽，不需要手動。

### 手動清理預覽

PR 關閉時 `preview.yml` 會自動刪。漏掉的話：`npx wrangler delete --name longtalk-pr-<號>`（在 repo 外的資料夾執行，避免讀到 `wrangler.jsonc`）。

## 3. 本機開發

```sh
npm run dev        # Vite ＋ Cloudflare 外掛：前端、Worker、Durable Object 都在本機跑
npm run lint && npm run typecheck && npm test && npm run build && npm run budget
```

本機 secret 放 `.dev.vars`（不進 git）。

## 4. 新增綁定或 Durable Object 時

- `wrangler.jsonc` 的 `migrations` **只能往後加**；已部署的 migration 不要改、不要刪。新增 DO class 就加一個新 tag。現有：`v1` `RoomDO`（A1）、`v2` `UsageDO`（B1，§6）、`v3` `TelemetryDO`（D3，§8）、`v4` `GuardDO`（I1，§11）；下一個是 `v5`。
- `vars` 也**不會繼承**：頂層與 `env.preview` 各寫一次（現有 `USAGE_LOW_QUALITY_GB`、`USAGE_AUDIO_ONLY_GB`，§6；預覽另有 Turnstile 的公開測試 key，§11）。
- `env.preview` **不會繼承**頂層的綁定：每個 DO、KV、R2、D1、Analytics Engine 綁定都要在 `env.preview` 重寫一次；R2／D1／Analytics Engine 要給預覽自己的資源，不要指到正式站的（Analytics Engine：正式站 `longtalk_events`、預覽 `longtalk_events_preview`，§8）。
- secret（SFU App token、TURN key、Turnstile secret key、AI 金鑰）只用 `wrangler secret put` 放在 Worker，**不進前端、不進 repo**（CLAUDE.md 規則 3；`npm run lint` 與 `npm run budget` 的 `scripts/secrets.ts` 會擋，§11）。要設定的 secret 見 §5。

## 5. Secrets 與 Realtime 互通測試（A2，B1 起改用會議室頁）

### 要設定的 secret

| 名稱 | 放哪裡 | 從哪裡拿 | 誰用 |
| --- | --- | --- | --- |
| `REALTIME_APP_ID` | Worker secret | Cloudflare 儀表板 → Realtime → SFU → 建立 app → **App ID** | `worker/sfu.ts`（A2 起） |
| `REALTIME_APP_SECRET` | Worker secret | 同一個 app 的 **App Secret**（API token；只顯示一次） | `worker/sfu.ts`（A2 起） |
| `REALTIME_TURN_KEY_ID` | Worker secret | 儀表板 → Realtime → TURN → 建立 key → **Turn Token ID** | `worker/turn.ts`（B3 起） |
| `REALTIME_TURN_KEY_API_TOKEN` | Worker secret | 同一個 TURN key 的 **API token**（只顯示一次） | `worker/turn.ts`（B3 起） |
| `ADMIN_TOKEN` | Worker secret | 自己產生的長亂數（例如 `openssl rand -base64 32`），當成 `/admin` 的密碼 | `worker/events.ts`（D3 起，§8） |
| `TURNSTILE_SECRET_KEY` | Worker secret（選用） | 儀表板 → Turnstile → 建立 widget → **Secret Key**（§11） | `worker/turnstile.ts`（I1 起；和 `TURNSTILE_SITE_KEY` 都設了才開） |
| `TURNSTILE_SITE_KEY` | `wrangler.jsonc` 頂層 `vars`（公開，不是 secret） | 同一個 widget 的 **Site Key**（§11） | `worker/rooms.ts` 回給瀏覽器（I1 起） |
| `IP_HASH_PEPPER` | Worker secret（選用、建議） | 自己產生的長亂數（`openssl rand -base64 32`）；**設了就不要改**（改了既有的封鎖與計數全部對不上） | `worker/client-key.ts`（I1 起，§11） |

App ID 不算機密，但和 App Secret 放在一起管理比較不會漏。**沒設定時 `/api/sfu/<roomId>/*` 對房間成員回 503 `sfu_not_configured`**，其餘功能照常（進得了房、看得到成員，只是沒有聲音與畫面）。

**TURN（B3）**：瀏覽器每次建立媒體連線前 `POST /api/turn/<roomId>`（帶 session token，房外 401），Worker 用 TURN key 向 Cloudflare 要 3 小時的短期憑證（key 的 API token 不離開 Worker），濾掉瀏覽器會擋的 port 53。**沒設定 TURN secret（或 Cloudflare 回錯）時只回 STUN**（`{"turn":false}`），通話照常，只是嚴格 NAT／擋 UDP 的網路連不上。檢查：`curl -X POST -H "Authorization: Bearer <token>" https://…/api/turn/<roomId>` 看 `turn` 是 `true`。要確認真的能走 TURN，在會議室網址加 `?ice=relay`（除錯旗標：強制所有路徑走 TURN；沒有 TURN 時無效），自己的名牌會出現「經由轉送伺服器」。

**B1 起代理綁定房間成員**（`worker/sfu.ts`）：每個呼叫都要帶 RoomDO 在 `welcome` 發的 session token（`Authorization: Bearer …`），沒帶或不認得一律 401；SFU session 屬於建立它的成員，動別人的 session 403；只能 pull 同一間房發布的軌（不然 404 `track_not_in_room`）。所以正式站設定 secret 之後，不在房間裡的人用不到 SFU 流量。

```sh
# 正式站（secret 會保留到之後每次部署）
npx wrangler secret put REALTIME_APP_ID
npx wrangler secret put REALTIME_APP_SECRET
npx wrangler secret put REALTIME_TURN_KEY_ID
npx wrangler secret put REALTIME_TURN_KEY_API_TOKEN

# 本機：寫進 .dev.vars（不進 git）
REALTIME_APP_ID=...
REALTIME_APP_SECRET=...
REALTIME_TURN_KEY_ID=...
REALTIME_TURN_KEY_API_TOKEN=...
```

PR 預覽的 Worker 每個 PR 都是新的：在 GitHub 也設定同名的 `REALTIME_APP_ID`、`REALTIME_APP_SECRET`、`REALTIME_TURN_KEY_ID`、`REALTIME_TURN_KEY_API_TOKEN`（`gh secret set …`），`preview.yml` 部署後會把它們寫進該 PR 的 Worker；沒設定就跳過（notice；沒有 TURN 的預覽只用 STUN）。建議預覽與正式站用**不同的 Realtime app**，流量分開看。

### 兩台裝置互通測試（會議室頁）

A2 的 `/dev/realtime` spike 在 B1 移除（代理不再接受匿名呼叫）；改用會議室本身：

1. 一台裝置在 PR 預覽或正式站按「開一間房」，把連結傳給另一台（手機的鏡頭權限需要 HTTPS，所以用 PR 預覽或正式站；同一台電腦可以用 `npm run dev` 開兩個分頁先試）。
2. 兩邊各自在預先加入頁允許麥克風與鏡頭，按「加入」。
3. 通過的條件：兩邊的格子都看到並聽到對方。把兩台裝置、瀏覽器、網路（例如 Wi-Fi 與 4G）與結果寫進 PR。
4. 檢查代理沒有開放給房外：`curl -i -X POST https://…/api/sfu/<roomId>/sessions` 要回 401。
5. **開關與裝置（B2，AC-2.3）**：一邊按工具列的「靜音」「關閉視訊」，另一邊的名牌要立刻出現紅色麥克風、格子換成名字首字；再打開要恢復畫面與聲音（不用重新整理）。用麥克風、鏡頭旁的 ▴ 選單換裝置（有喇叭選單的瀏覽器也換喇叭），通話不斷；通話中拔掉正在用的 USB 麥克風或鏡頭，要自動換到另一個並跳出通知，沒有別的就出現「中斷了」的提示，接回去會自動恢復。到網址列把鏡頭權限改成「封鎖」再進房，要看到權限說明與「重試」。
6. **TURN（B3，AC-2.4）**：其中一台開 `…/r/<房間>?ice=relay` 加入，通話照常、自己的名牌出現「經由轉送伺服器」；或在擋 UDP 的網路（公司網路、部分手機熱點）直接加入。
7. **斷線重連（B3，AC-2.5）**：通話中把一台的 Wi-Fi 關掉 30 秒再打開：它自己看到「連線中斷，正在重新連線…」，另一台的名牌在 RoomDO 發現斷線後標「重新連線中」（瀏覽器判定離線時立刻，網路默默斷掉最多約 60 秒）；網路回來 8 秒內恢復聲音與畫面、還是同一個人（沒有多一格）。手機切到背景再回來、重新整理分頁也要接回同一席位。

8. **手機版面（C3，AC-4.6）**：用 **iPhone Safari** 與 **Android Chrome** 各跑一次（電腦開房，再用其他分頁或裝置湊到 6 人；分頁多開沒關係，假裝的人不用開鏡頭）：
   - **直拿、3 人**：一頁、單欄或 2×2、沒有頁點；工具列一列五鍵（麥克風、鏡頭、聊天、參與者、更多），拇指搆得到；「離開」在右上角紅色。
   - **直拿、6 人**：下方出現兩個頁點；左右滑一下就換一頁、停在整頁上（不會停在半頁）；第二頁 2 格置中；滑過去後第一頁的人聲音照常聽得到。
   - **網址列**：在房內上下滑、轉動、切到別的 App 再回來，畫面不跳、不出現白邊，工具列不被網址列或底部 Home 指示條蓋住；瀏海與動態島不壓到頂部條。
   - **選單**：點「更多」、麥克風或鏡頭旁的 ▴，從下方滑出抽屜，選項夠大好點；點抽屜外或「關閉」收起；在抽屜裡換鏡頭（前／後鏡頭）通話不斷。
   - **橫拿**：自動切成演講者：講話的人大格、其他人在右側一欄（太多人時可上下捲）；換人講話約 1 秒後大格跟著換（咳嗽、短聲不會換）；轉回直拿回到分頁。
   - **系統設定「減少動態效果」打開**（iOS：輔助使用 › 動作；Android：協助工具 › 移除動畫）：點頁點換頁時直接跳過去、抽屜不滑動。
   - 把兩支手機的型號、系統與瀏覽器版本、結果寫進 PR；兩支都通過才勾 AC-4.6。

9. **螢幕分享（D1，AC-3.1、AC-3.3、AC-4.3）**：兩台不同的電腦（再加一支手機看版面）：
   - A 用 Chrome 分享**整個螢幕**，B 在 2 秒內看到，版面切成分享為主（主區＋右側一欄人），分享格左上「A 的畫面」。選擇器裡不應該出現 LongTalk 自己的分頁。
   - A 改分享**一個視窗**、再改分享**一個分頁**（也試 Chrome 分享列的「改為分享這個分頁」）。
   - A 看到舞台上方的「你正在分享畫面」條、工具列的紅色「停止分享」；分別用**提示條**、**工具列**、**瀏覽器原生的「停止分享」**停止，每次 B 都回到格狀、A 的提示條消失。
   - A 分享中 B 按「分享螢幕」：H5 起不再問接手，兩人同時分享（第 24 步）。
   - 手機（iPhone Safari 或 Android Chrome）看電腦的分享：直拿分享在上、人在下面一列；橫拿分享是大格、人在右側；手機上沒有分享按鈕。
   - Mac：在「系統設定 › 隱私權與安全性 › 螢幕與系統錄音」關掉瀏覽器的權限再分享，要看到說明文字；關掉選擇器（取消）不應該跳任何提示。
   - 分享一份文件，B 那邊字看得清楚；分享中 A 關 Wi-Fi 10 秒再打開，分享自己恢復。
   - 把電腦與手機的系統、瀏覽器版本與結果寫進 PR；都通過才勾 AC-3.1、AC-3.3、AC-4.3。

10. **分享音訊（D2，AC-3.2；手機說明是 AC-3.6 的一半）**：兩台不同的電腦（B 戴耳機或開喇叭都試），再加一支手機：
    - A 用 Chrome（或 Edge）分享**一個正在播 YouTube 的分頁**，選擇器裡「同時分享分頁音訊」保持勾選：B 聽得到影片聲音、聲音和畫面大致同步、音樂不會被當成雜音壓掉；A 自己也照常聽得到那個分頁。A 的提示條出現「關閉分享音訊」與「戴耳機可以避免回音」。
    - A 按「關閉分享音訊」：B 立刻聽不到影片、畫面照常；按「開啟分享音訊」聲音回來。A 的麥克風開關與分享音訊互不影響（A 靜音時 B 仍聽得到影片，反之亦然）。
    - A 分享**整個螢幕**（Windows 勾「分享系統音訊」）：B 聽得到 A 電腦的聲音，但**聽不到自己的聲音從 A 那邊傳回來**（B 對麥克風講話、A 開喇叭）。如果聽得到自己的回音，記下 Chrome 版本（`restrictOwnAudio` 沒生效），寫進 PR。
    - A **開喇叭**（不戴耳機）分享有聲音的分頁：B 是否聽到兩次（一次分享音訊、一次 A 的麥克風收到喇叭）；記下結果，決定要不要預設關掉分享者本機播放（`suppressLocalAudioPlayback`）。
    - A 分享**沒有聲音的來源**（一個視窗，或取消勾「分享分頁音訊」）：分享照常、沒有錯誤提示、提示條沒有音訊按鈕。
    - 三條停止路徑（提示條、工具列、瀏覽器原生「停止分享」）與**主持人停止**：每次 A 的分享音訊都跟著停（B 不再聽到 A 的影片）。
    - A 用 **Firefox** 或 **Safari** 分享：選擇器沒有音訊選項、提示條沒有音訊按鈕，畫面照常。
    - **手機**（iPhone Safari、Android Chrome）：工具列沒有分享鈕；「更多」第一項是灰色的「分享螢幕」，下面寫「手機瀏覽器不能分享螢幕。要分享，請用電腦加入這間會議室。」，點了沒反應；手機聽得到電腦分享的聲音。桌機 Chrome 把視窗拉窄到手機版面：「更多」第一項是可以按的「分享螢幕」。
    - 把電腦與手機的系統、瀏覽器版本與結果寫進 PR；都通過才勾 AC-3.2（AC-3.6 還要等簡報者檢視 `e3-t08`）。

11. **聊天（D3，AC-5.1）**：兩台不同的裝置（一台電腦、一支手機；手機用 iPhone Safari 或 Android Chrome 都試更好）：
    - 電腦按工具列「聊天」：右側出現 320 px 的聊天欄、舞台跟著變窄，游標已經在輸入框。打一句中文（注音或倉頡選字時按 Enter **只選字、不送出**）、Shift + Enter 換行、Enter 送出；貼一個網址，兩邊都變成可點的連結、在新分頁開啟。
    - 手機聊天沒開時：電腦送一則，手機工具列「聊天」上出現 1、畫面下方跳出氣泡預覽（名字＋前兩行），約 6 秒後消失；點氣泡打開全螢幕聊天抽屜，未讀數歸零。抽屜裡用手機鍵盤打中文：**注音選字按 Enter（換行鍵）只選字、不送出**，手機上 Enter 是換行、只有「送出」鈕會送，輸入框下的小字是「按「送出」鈕傳送，Enter 換行」；按「送出」鈕，鍵盤不擋住剛送出的訊息；「關閉」或返回收起。
    - 電腦連續快速送 11 則：第 11 則留在輸入框、下方提示「你傳得太快了」；等 10 秒可以再送。
    - 手機重新整理頁面（或關 Wi-Fi 30 秒再打開）：回到房間後先前的訊息都還在，斷線期間別人傳的也補上，而且不算成一堆未讀。
    - 第三個人（另一個分頁也可以）中途加入：看得到加入前的訊息。
    - 把兩台裝置的系統、瀏覽器版本與結果寫進 PR；都通過才勾 AC-5.1。

12. **主持人控制（F1，AC-1.4 的主持人部分）**：兩台不同的裝置（A 電腦是主持人＝第一個進房的人；B 手機），最好再一個分頁 C：
    - A 按工具列「參與者」：右側出現名單、上方可切換「聊天｜參與者」；A 是「主持人」，B 的麥克風、鏡頭狀態和 B 實際一樣。B 手機上點「參與者」是全螢幕抽屜，**看不到任何 ⋯ 選單、全員靜音、結束會議**。
    - A 在 B 那列 ⋯ › **靜音**：B 的麥克風按鈕立刻變成「解除靜音」、跳出「主持人 A 將你靜音了…」；A 聽不到 B。B 自己按「解除靜音」可以再講話（A 沒有辦法幫 B 打開）。
    - A ⋯ › **關閉鏡頭**：B 的鏡頭關掉（手機的鏡頭燈熄）、B 看到提示；B 自己可以再打開。
    - B（或 C 用電腦）分享畫面，A ⋯ › **停止分享**：分享停止、分享者看到「主持人 A 停止了你的分享畫面」。
    - A 按 **全員靜音**：B、C 都被靜音並看到提示，A 自己沒被靜音。
    - A ⋯ › **移出會議室** › 確認：B 看到「你已被移出會議室」、沒有「重新加入」；B 在同一個瀏覽器重新開連結、按加入，**又是**被移出的畫面；B 用私密視窗或另一個瀏覽器可以進來（已知限制，寫在 E1 `e1-t07`）。10 分鐘後同一個瀏覽器可以再進來。
    - A 按 **結束會議** › 確認：B、C 都看到「主持人已結束會議」；再開同一個連結是「找不到這間會議室」。
    - 把兩台裝置的系統、瀏覽器版本與結果寫進 PR。AC-1.4 要等共同主持人（`e1-t16`）也能做這些才勾。

13. **鎖房與等候室（F2，AC-1.5）**：兩台不同的裝置（A 電腦是主持人；B 手機，最好 iPhone Safari 與 Android Chrome 各試一次），再加一個 C（另一台電腦或私密視窗）：
    - A 打開「參與者」：上方有「鎖定會議室」「等候室」兩個開關；B 打開「參與者」**看不到**這兩個開關。
    - A 打開「等候室」。B 用另一個瀏覽器（或私密視窗）重新開連結：預先加入頁寫「這間會議室開了等候室」；按加入後是**等候畫面**：房名、自己的鏡頭預覽（鏡像）、「你是下一位」、「主持人會讓你進來」；麥克風、鏡頭開關可以按；A 聽不到、看不到 B。
    - A 那邊跳出「B 在等候室，等你放行」（不出聲）、工具列「參與者」的徽章變成琥珀色的 1；面板裡「等候中 1」有 B。
    - C 也加入等候：B 的畫面還是「你是下一位」，C 是「你排在第 2 位，共 2 人在等」。
    - A 按 B 的「放行」：B **同一頁**直接進會議室（不用再輸入名字、裝置是剛剛那一組），A、B 互相看得到、聽得到；C 變成「你是下一位」。
    - A 按 C 的「拒絕」：C 看到「主持人沒有讓你進入」；C 馬上「再試一次」→ 加入，**又是**拒絕畫面；等 1 分鐘再試，又回到等候室。
    - C 在等候時，B 手機重新整理：B 還是在會議室裡（不用等候）。C 重新整理：還是在等候室、排位不變。
    - A 關掉「等候室」：先問「放行 N 人並關閉」，確認後 C 進房。
    - A 打開「鎖定會議室」：A、B、C 的頂部條都出現鎖頭「已鎖定」。另一個瀏覽器開連結：直接是「這間會議室已鎖定」（不會先要鏡頭權限）。B 手機關 Wi-Fi 30 秒再打開（寬限期內）：**回得來**。A 解鎖後，新的人可以加入。
    - （選測）A 打開等候室後離開，B 變成主持人，再有人來等時 B 看得到並能放行；房裡沒人時等候中的人看到「主持人目前不在線上」。
    - 把裝置的系統、瀏覽器版本與結果寫進 PR；通過才勾 AC-1.5。

14. **演講者版面、釘選、聚光燈、隱藏格子（G2，AC-4.4）**：兩台不同的裝置（A 電腦是主持人；B 手機），再加一個 C（另一台電腦，或 A 電腦的另一個瀏覽器）；三人都開鏡頭，C 先關鏡頭：
    - A「更多 › 版面 › 演講者」：B 講話滿 1 秒後 B 進大格，其他人在**下方一列**；A、B 輪流講話，大格不會在 3 秒內來回跳。重新整理 A：還是演講者版面。換回「格狀」。
    - A 把滑鼠移到 C 的格子上按圖釘「釘選 C」：A 的大格是 C（右上「已釘選」），B 的畫面**不變**；A 按「更多 › 取消釘選」回到格狀。
    - A 在 B 的格子按「把 B 設為聚光燈」：A、C 的主區都是 B（右上「聚光燈」）；B 手機跳出「你被設為聚光燈…」，B 自己的畫面大格是自己。B 用手機（參與者）**看不到**聚光燈鈕。C 釘選 A：C 的大格是 A，其他人還是 B；C 取消釘選又回到 B。
    - C 分享畫面：分享在主區，B（聚光燈）排在側列第一個；C 停止分享後回到聚光燈。
    - B 手機直拿、橫拿：聚光燈時直拿是大格在上、其他人在下面一列，橫拿是大格加右側一欄；A 結束聚光燈後直拿回到 4 格分頁。
    - A 結束聚光燈；B 離開再進來：沒有聚光燈。再設一次聚光燈給 B，B 關 Wi-Fi 30 秒再打開：回來時聚光燈還在。
    - A「更多 › 隱藏自己」：A 的格子不見、其他人看得到 A；重新整理 A：還是隱藏。只剩 A 一個人時 A 的格子照樣出現。
    - A「更多 › 隱藏沒有視訊的人」：C（鏡頭關）不見、上方「已隱藏 1 位沒有開視訊的人」，**C 講話 A 照樣聽得到**；參與者名單有 C；按「全部顯示」回來。
    - 把裝置的系統、瀏覽器版本與結果寫進 PR；通過才勾 AC-4.4 的這五項（多人分享時選主區是 H5）。

15. **密碼、共同主持人、結束會議（F3，AC-1.4 的共同主持人部分；AC-1.8 已由測試勾）**：兩台不同的裝置（A 電腦是主持人；B 手機），再加一個 C（另一台電腦或私密視窗）：
    - A 打開「參與者」› 會議室設定 › 「會議室密碼」› 設定 `tea4two`：面板寫「已設定，新加入的人要輸入密碼」。B 打開「參與者」**看不到**密碼那一列。
    - C 開不含密碼的連結：預先加入頁多一欄「會議室密碼」；打錯一次寫「密碼不對」；連錯 3 次寫「請等 30 秒」並倒數、加入鍵停用；30 秒後打對就進來。
    - A 在「更多」按「複製含密碼的連結」，貼到 B 手機的瀏覽器打開：網址列**看不到** `pwd=`（重新整理或看瀏覽紀錄也沒有）；密碼欄已填好、寫「已從連結帶入密碼」，按加入就進來。
    - B 手機關 Wi-Fi 30 秒再打開（寬限期內）：不用再輸入密碼就回來。
    - A 在 B 那列 ⋯ › **設為共同主持人**：B 跳出「主持人 A 把你設為共同主持人」；B 打開「參與者」看得到鎖房、等候室開關（沒有密碼那列），對 C 的 ⋯ 有靜音、關鏡頭、移出，**沒有**設為共同主持人、設為主持人；對 A **沒有** ⋯；面板底部有「全員靜音」，**沒有**「結束會議」。
    - B 靜音 C：C 看到「共同主持人 B 將你靜音了…」、A 和 B 都聽不到 C；B 關 C 的鏡頭、停止 C 的分享也照樣有效（媒體相關，這一步是 AC-1.4 要兩台裝置的原因）。
    - A ⋯ › **設為主持人** 給 C › 確認：C 跳出「主持人 A 把主持人交給你了」、A 變成共同主持人。C 再把主持人交回 A（或照下一步測）。
    - 主持人按「離開」：問「要離開會議嗎？」，下拉的第一個是「B（自動）」（共同主持人優先）；選「只有我離開」：B 變成主持人並跳提示。
    - 新主持人按「離開」›「結束會議（所有人）」：自己看到「你已結束會議」，其他人看到「主持人已結束會議」。**在結束前讓一台關掉 Wi-Fi**、結束後 1 分鐘內打開（還在自動重連）：看到的是「主持人已結束會議」，不是「這間會議室已經關閉」。
    - 把裝置的系統、瀏覽器版本與結果寫進 PR；第 12 步與這一步都通過才勾 AC-1.4。

16. **反應、舉手、音效（G3，AC-5.3、AC-4.5；AC-5.2 已由 e2e 勾）**：兩台不同的裝置（A 電腦是主持人；B 手機，iPhone Safari 與 Android Chrome 各試一次更好），再加一個 C（另一台電腦或私密視窗）；**A、B 開喇叭或戴耳機**：
    - B 手機工具列是五鍵：麥克風、鏡頭、**反應**、聊天、更多；「更多」第一項（分享說明之後）是「參與者（3 人）」，點了打開參與者抽屜。A 把 B 設為共同主持人、開等候室，再用私密視窗加入一個人等著：B 手機的「更多」帶琥珀色的等候人數；之後關掉等候室、取消 B 的共同主持人。
    - B 按「反應」› 👍：抽屜關掉，A、C 看到 👍 從 B 的格子往上飄、5 秒後消失；B 自己的格子也有。A 按「反應」連按 👏 四下：面板不關，大家看到 A 的格子上一個「👏 ×4」。A 連按超過 8 下：跳「反應送得太快了…」。
    - C「更多 › 版面 › 隱藏表情反應」：之後誰的反應 C 都看不到，重新整理 C 還是隱藏；取消勾選。A「更多 › 隱藏自己」再送 🎉：A 舞台左下角出現「你 🎉」。
    - 電腦的系統設定打開「減少動態效果」（Windows：設定 › 協助工具 › 視覺效果 › 動畫效果關；macOS：輔助使用 › 顯示器 › 減少動態效果）：反應不再飄，而是在格子中下方停一下（約 2.5 秒）就消失。
    - B 按「反應」›「舉手」：B 看到「你舉手了…」、工具列圖示變琥珀色的手；A 跳「B 舉手了」並**聽到舉手音效**；C（參與者）看到 B 格子右上的「✋ 舉手」但沒有 toast、沒有音效。C 也舉手：A 的參與者名單最上面依序是 B（✋ 1）、C（✋ 2）。
    - A 在 C 那列 ⋯ ›「放下手」：C 跳「主持人 A 放下了你的手。」；B 自己按「反應」›「放下手」。B 關 Wi-Fi 30 秒前先舉手：回來時手還舉著。
    - **音效**：C 離開再進來，A、B 聽到離房與進房兩個音（房裡 8 人以下）；B 傳聊天訊息，A 聊天沒開時聽到短音、打開聊天時不響；A「更多 › 通知 › 音效」取消勾選後以上都不響，重新整理 A 還是關著。重新整理後**還沒點過頁面**之前有人進房：不響（之後點一下頁面就會響）。選了喇叭的電腦 Chrome：音效從選的喇叭出來。
    - 把裝置的系統、瀏覽器版本與結果寫進 PR；通過才勾 AC-5.3，AC-4.5 也在這一步通過後勾。

17. **預先加入完整版、語言（G1，AC-4.2、AC-4.8 的語言部分）**：一台電腦（Chrome 或 Edge，接**兩個喇叭**：例如內建喇叭＋耳機），一支手機（iPhone Safari 與 Android Chrome 各試一次更好）：
    - 電腦打開房間連結：「喇叭」選單選耳機 › 按「測試喇叭」：**提示音從耳機出來**、按鈕變「停止測試」；改選內建喇叭再按：從內建喇叭出來。iPhone Safari 上沒有「喇叭」選單也沒有「測試喇叭」。
    - 麥克風開著不出聲 6 秒：音量表下方出現「沒有偵測到聲音…」；說話後消失。
    - 選一個 USB 麥克風或鏡頭 › 重新整理：還是選著它；拔掉它：預覽自動換到另一個、選單顯示正在用的那個；接回去再重新整理：又選回它。
    - 主持人開等候室後，另一台打開連結：看到「這間會議室開了等候室」狀態卡、按鈕是「要求加入」，按了進等候室。
    - 網址列把鏡頭與麥克風改成「封鎖」再重新整理：看到「瀏覽器擋住了麥克風和鏡頭」與這個瀏覽器的步驟（Chrome 是「網站資訊」圖示那套、Edge 是鎖頭那套）；照步驟改成允許：Chrome／Edge **不用按就自動再試**、預覽回來。手機各試一次：iPhone Safari 是「aA › 網站設定」那套、Android Chrome 是「網址左邊的圖示 › 權限」那套。Mac 上到「系統設定 › 隱私權與安全性 › 相機」關掉這個瀏覽器：顯示「系統擋住了…」並先列 Mac 的步驟。
    - 預先加入頁最下面「語言」選 English：整頁換英文、重新整理還是英文；進房後工具列、參與者、聊天都是英文，「更多 › 語言 › 繁體中文」切回，**通話不斷**（對方沒有看到你離開再進來）。聊天時間：繁中 21:04、英文 9:04 pm。換一台瀏覽器語言只有英文的電腦（或私密視窗、Chrome 設定把中文刪掉）第一次打開：是英文；有中文就是繁中。
    - 把裝置的系統、瀏覽器版本與結果寫進 PR；通過才勾 AC-4.2。

18. **PWA 與快捷鍵（G4，AC-4.7、AC-4.9 的快捷鍵部分）**：一台電腦（Chrome 或 Edge）、一支 Android（Chrome）、一支 iPhone（Safari）：
    - **安裝**：電腦 Chrome 打開首頁，「加入」下方出現「安裝 LongTalk」卡片 › 按「安裝」› 瀏覽器自己的安裝對話框 › 安裝：桌面或「應用程式」有藍綠方塊的 LongTalk，打開是**沒有網址列的獨立視窗**（standalone），再開首頁不再出現卡片。另一台（或清除網站資料後）按「不用了」：重新整理不再出現。Android Chrome 同樣有「安裝」（或選單裡的「安裝應用程式」），裝好從主畫面打開是全螢幕的 App。iPhone Safari 第一次打開首頁看到「把 LongTalk 加到主畫面」的提示（「分享」›「加入主畫面」），照做：主畫面圖示是 LongTalk、打開沒有 Safari 的網址列；**第二次打開首頁不再出現提示**。會議室裡從不出現安裝卡片。
    - **離線殼**：裝好的 App（或開過一次首頁的瀏覽器）關掉 Wi-Fi 與行動網路再打開：首頁照樣出現，寫「你目前離線…」；點一個房間連結：「你目前離線」＋「再試一次」，打開網路後**自己重試**、進到預先加入頁。
    - **新版本**：開著一個房間（電腦與手機都在裡面），合併任何改到程式的 PR（部署完成後）：幾分鐘內或切回分頁時，兩邊左下角出現「有新版本。重新整理後會直接回到這場會議…」卡片，**通話不會自己中斷**；按「稍後」卡片消失、繼續開會；離開會議回首頁時（換頁）才自動換新版。另一台按「重新整理」：約幾秒回到同一場會議、同一格。只改文件的 PR 合併後**不應該**出現卡片。
    - **快捷鍵**（電腦）：在房間裡按 M（靜音／解除）、V、C（聊天打開）、在聊天框打字 m、v、空白不觸發、Esc 關聊天、P、R（舉手）、?（清單）、L（先問「要離開會議室嗎？」）；用注音輸入法在聊天框選字時按空白或 Enter 不觸發。靜音時**按住空白鍵**：另一台聽得到、名牌的紅色麥克風消失，放開立即靜音；按住時切到別的視窗也會恢復靜音。Ctrl／Cmd＋C、V、R、L 這些照舊是瀏覽器的。把滑鼠移到工具列按鈕上，提示寫「靜音（M）」。
    - 把裝置的系統、瀏覽器版本與結果寫進 PR；安裝與 standalone 三台都通過才勾 AC-4.7（AC-4.9 的其餘部分在第 19 步）。

19. **無障礙快速檢查（G5，AC-4.9、AC-4.10 之外的人工部分）**：一台 Mac（Safari＋VoiceOver，⌘F5 開關）或 iPhone（設定 › 輔助使用 › VoiceOver），一台 Windows（Chrome 或 Edge＋[NVDA](https://www.nvaccess.org/)，免費），各 10 分鐘；另一台裝置在房間裡當對方：
    - **只用鍵盤開一場會**（電腦，不碰滑鼠）：首頁 Tab 到「開一間房」Enter → 預先加入頁游標在名字欄、打名字 Enter 進房 → Tab 依序經過頂部條、格子的「釘選」鈕（Tab 到時才出現）、工具列；每個焦點都看得到藍綠色外框；M、V、空白鍵按住說話；「反應」Enter 開選擇器、方向鍵選、Enter 送出、Esc 關；「參與者」Enter → Tab 到對方的「⋯」Enter 開選單、方向鍵選「靜音」、Esc 關選單後焦點回到「⋯」；? 開快捷鍵清單、Esc 關；L 離開。過程中**沒有卡住出不來的地方**（對話框、抽屜裡 Tab 只在裡面繞，Esc 一定關得掉）。
    - **VoiceOver／NVDA**：首頁念得出標題「開著就不會斷的會議室」與每個按鈕的名稱；預先加入頁的名字欄念「你的名字」；進房後移到對方的格子念「名字」加狀態（例如「主持人，麥克風已關，鏡頭沒開」），**對方說話時不會一直插話**；按 M 念「麥克風已關閉／已開啟」；對方舉手、你被主持人靜音、有人在等候室時念出提示（一次，不重複）；按住空白鍵念「按住說話中…」、放開念「已恢復靜音」；工具列「參與者」念「參與者（2 人）」、聊天有未讀時念「聊天（1 則未讀）」。
    - **外觀**：首頁右上「外觀」選「深色」／「淺色」：整頁立刻換、重新整理還在；選「跟隨系統」回到系統的；進房一律深色。系統設定「減少動態效果」打開：抽屜不滑動、反應不飄、換頁直接跳。
    - 把裝置、螢幕閱讀器版本與結果寫進 PR；都通過才勾 AC-4.9（Lighthouse 與 axe 由 `UI checks` 擋）。

20. **Simulcast 與選層（H1，AC-2.6）**：一台電腦（Chrome 或 Edge）、一支手機（Android Chrome 與 iPhone Safari 各試一次更好），再湊到 **8 人**（另一台電腦開私密視窗或 headless bot 都可以，但至少兩台是不同的真實裝置；bot 不要放在你自己那台電腦，它們會吃掉 CPU 與上行）。電腦另開一個分頁 `chrome://webrtc-internals`（看 `inbound-rtp` 的 `frameHeight`、`bytesReceived_in_bits/s`，與 candidate-pair 的 `bytesReceived_in_bits/s`）：
    - **發布**：電腦的 `outbound-rtp` 有三條 video，`rid` 是 `f`／`h`／`q`，大約 1280×720、640×360、320×180（鏡頭本身做不到 720p 時會少一層，正常）；手機也是三條（iPhone Safari 若只有一條，寫進結果：Safari 拒絕 simulcast 時退回一層，別人照樣看得到）。開始分享：分享的 `outbound-rtp` 兩條（原尺寸與一半）。
    - **8 人格狀**：電腦視窗開到一般大小，等 20 秒：每個格子的 `frameHeight` 大多是 **360**（格子比 360 行小），candidate-pair 的接收 **≤ 4 Mbps**（AC-2.6 的數字）。把視窗拉到全螢幕：格子變大時有的會換到 720（其他會降，總量仍 ≤ 4 Mbps）；拉回去後過幾秒換回 360。
    - **大格與條帶**：釘選一個人：幾秒內他的 `frameHeight` 變 **720**，下方條帶的人變 **180**（降層可能要 10 秒左右）。取消釘選：回到 360。
    - **手機直拿翻頁**：手機第 1 頁的 4 格清楚（手機像素多，常是 720），翻到第 2 頁：電腦上看不到變化，但手機收的總量不應該增加（第 1 頁的人變成最低層）；翻回來 1–2 秒內又清楚。
    - **分頁在背景**：在 `chrome://webrtc-internals` 分頁上停 15 秒（會議室分頁在背景）：所有 `frameHeight` 降到 180、接收量大降；切回會議室：幾秒內恢復。
    - **分享**：電腦分享，手機看：手機的分享 `frameHeight` 是 540（一半那層，手機的分享框小），電腦另一個接收者是 1080。
    - 把裝置、系統、瀏覽器版本、8 人時的接收量與上面幾項的結果寫進 PR；**兩台不同裝置都對上才勾 AC-2.6**。
21. **聲音處理、靜音中講話提醒、HD 與純音訊模式（H3，AC-6.1、AC-6.3、AC-6.4 的一部分）**：兩台不同裝置（一台電腦 Chrome 或 Edge、一支手機；Safari 或 Firefox 能多試一台更好），對方戴耳機聽。電腦另開 `chrome://webrtc-internals`。
    - **設定面板**：電腦「更多 › 設定…」是對話框、手機是全螢幕抽屜，三個分頁「音訊／視訊／效能」；預先加入頁的「設定」也打得開。音訊頁有麥克風與喇叭選單、視訊頁有鏡頭選單，換裝置和工具列的選單一樣。**瀏覽器不認得的開關不顯示**（記下每個瀏覽器顯示了哪幾個）。
    - **三個開關即時生效（AC-6.1）**：預設三個都開。通話中在電腦旁邊開風扇或敲鍵盤：關「噪音抑制」→ 對方明顯聽到更多背景聲、再開回來 → 變小；用喇叭（不戴耳機）講話、對方也用喇叭：關「回音消除」→ 對方聽到自己的回音；關「自動調整音量」→ 小聲講話時對方聽到的音量變小。每次切換通話**不斷**、對方的畫面不閃；`webrtc-internals` 的 `outbound-rtp`（audio）不會多出一條（換軌不重新協商）。重新整理後開關還是剛剛的樣子。把每個瀏覽器是「即時改」還是「重開麥克風」寫進結果（後者麥克風的 `track` id 會換）。
    - **靜音中講話（AC-6.3）**：按靜音，對著麥克風講 2 秒以上：舞台上方出現「你目前是靜音」與「取消靜音」；按「取消靜音」→ 麥克風打開、對方聽得到。再靜音、再講：30 秒內不會再出現。按住空白鍵說話（按住說話）時與剛放開時不出現。**靜音時對方完全聽不到**（對方 `inbound-rtp` audio 的 `bytesReceived` 不增加）。
    - **HD（AC-6.4 的一半）**：電腦預設開、手機預設關（設定的視訊頁）。電腦關 HD：`outbound-rtp` 的 `f` 層停止（`active` 變 false、位元率 0），對方釘選你時 `frameHeight` 最高 360；開回來幾秒內回到 720。用 Chrome DevTools › Network › Throttling 自訂上傳 1 Mbps（或手機熱點），HD 開著約 30 秒後跳出「上傳網路不夠快，先暫停 HD 視訊」，設定頁寫「暫時不送 HD」，`f` 層停止；拿掉限速約 1 分鐘後自己恢復。
    - **純音訊模式**：「更多 › 純音訊模式」（或設定的效能頁）：你看不到任何人的畫面（格子是首字）、鏡頭燈熄，別人看到你的首字；聲音兩邊照常；`webrtc-internals` 的 video `inbound-rtp` 消失、candidate-pair 接收量大降。按舞台上方的「恢復視訊」→ 畫面回來、鏡頭打開（原本是開的話）。預先加入頁的設定開純音訊模式再加入：進房就是純音訊、鏡頭不開。
    - 結果（裝置、系統、瀏覽器版本、每項通過與否）寫進 PR 或 issue；**AC-6.1、AC-6.3 兩台不同裝置都對上才勾**；AC-6.4 還要省電模式（H4，`e6-t05`）與 E2 統計面板（H2）反映這些變化，那時才勾。
22. **訊號格、連線統計、頻寬自適應（H2，AC-2.7）**：兩台不同的裝置（A 電腦、B 手機），再湊到 4 人以上（另一台電腦或 bot）；都開鏡頭。**要一個真的會變差的網路**：瀏覽器的 DevTools「節流」管不到 WebRTC，請用系統層的工具：Mac 的 Network Link Conditioner（Xcode 的 Additional Tools）、iPhone 的「設定 › 開發者 › Network Link Conditioner」、Windows 的 [clumsy](https://jagt.github.io/clumsy/)（丟包、延遲，免費），或帶手機走到訊號差的地方（電梯、地下室）。
    - **訊號格**：每個名牌名字後面有三格訊號，網路正常時三格綠色。B 開始丟包（例如 10 %）後約 6 秒，B 自己的名牌變成一格紅色（差），A 看到 B 的名牌在 5–10 秒內也變；恢復後約 6–10 秒回到三格。滑鼠移到訊號格上（電腦）會寫「訊號好／普通／差」。
    - **連線統計**：「更多 › 連線統計」：電腦是右側面板（舞台變窄、照常可用）、手機是全螢幕抽屜；每 2 秒更新往返延遲、接收／傳送位元率、丟包、路徑（`?ice=relay` 加入時寫「經由轉送伺服器（TURN）」）、自動調整的狀態；「你送出的」鏡頭有 `f`／`h`／`q` 三層、「你收到的」每個人的鏡頭與麥克風。切英文時整個面板是英文。按「匯出 JSON」下載一個檔：打開看得到名字與數字，**沒有** token、密碼、SDP。
    - **下行降級**（在 B 上限制下行，例如 Network Link Conditioner 的 3G 或 clumsy 丟包 8 %）：約 4–6 秒內 B 跳出「網路不穩，已降低畫質」，別人的格子變糊（統計面板「要求的層」變低）；再撐不住時「網路不穩，已暫停其他人的視訊（聲音照常）」：除了正在講話／釘選的人，其他格子變成名字首字，**聲音都還在**；還是不行就出現「網路不佳…切換成純音訊」的提示條，按「切換成純音訊」後不收任何視訊、自己的鏡頭關掉，提示條換成「純音訊模式…恢復視訊」。拿掉限制：約 10 秒起一段一段恢復（先恢復收視訊、再慢慢變清楚），最後「網路恢復，畫質已恢復」。
    - **上行降級**（在 A 上限制上行，例如 1 Mbps）：約 10 秒內 A 跳出「上傳頻寬不足，已降低你送出的畫質」，`chrome://webrtc-internals` 裡 A 的 `outbound-rtp` `rid=f` 變成 `active: false`（統計面板「送出的層」寫 `f · 已關閉`），別人看 A 的大格最多 360；拿掉限制 30 秒以上後恢復（「你送出的畫質已恢復」）。
    - 全程**聲音不斷**：降級、停收視訊、恢復時都不重新連線、不換席位。
    - 把網路工具與設定、裝置與瀏覽器版本、每一段大約幾秒出現寫進 PR；**兩台不同裝置都對上才勾 AC-2.7**。
23. **進階噪音抑制與省電模式（H4，AC-6.2、AC-6.4 的其餘部分）**：兩台不同裝置（A 電腦 Chrome 或 Edge；B 手機或另一台電腦，**戴耳機**聽），最好再試一台 Safari 或 Firefox。A 另開 `chrome://webrtc-internals`。
    - **開關與隱藏**：A「更多 › 設定… › 音訊」最下面有「進階噪音抑制」，預設關。打開：上面的「噪音抑制」開關變灰、寫「由它處理噪音」；幾秒內沒有「正在載入…」也沒有錯誤提示。`webrtc-internals` 的 audio `outbound-rtp` **不會多一條**（換軌、不重新協商）；開關的瞬間 B 不應該聽到斷掉（最多一下很短的切換）。在不支援的瀏覽器（或 http 開的頁面）這個開關不出現；把這幾個瀏覽器有沒有出現寫進結果。
    - **錄音比對（AC-6.2 的核心）**：B 用手機或電腦的錄音程式錄下 A 的聲音（或用 OBS 錄 B 的喇叭輸出），A 在旁邊**連續敲鍵盤、開電風扇或吹風機**，同時念同一段話：①進階關、瀏覽器噪音抑制開 ②進階開。比對兩段：②的鍵盤聲、風扇聲要**明顯更小**、人聲清楚不發悶。把兩段錄音（或截圖波形）附在 PR／issue；**這一項通過才勾 AC-6.2**。
    - **延遲與聲音**：A、B 視訊通話，A 拍手：開與關進階噪音抑制，B 感覺不到額外的延遲（理論上多約 10–20 ms）；A 說話不會斷斷續續、沒有爆音。A 靜音時 B 完全聽不到；按住空白鍵說話照常；A 靜音時講話 2 秒仍出現「你目前是靜音」。
    - **CPU 門檻**：「更多 › 連線統計」的「模式」寫「開・處理器 x %・延遲 y ms」，記下 A 的 x、y（還有裝置型號）。在一台舊筆電或手機上試：如果出現「你的裝置忙不過來，已關閉進階噪音抑制」，記下當時的負載；如果都沒出現，可以在 Chrome DevTools › Performance › CPU 4× slowdown 下（不一定影響 audio thread）或同時開很多分頁試試，記下結果，決定門檻（35 %、2.4 ms、5 秒）要不要調。
    - **重新整理直接回房**：開著進階噪音抑制，重新整理（自動回到同一席位）：B 照樣聽得到 A（沒點頁面前送的是原本的麥克風）；設定頁寫「點一下頁面…」，點一下後消失。
    - **省電模式（AC-6.4 的一半）**：A「設定 › 效能 › 省電模式」：別人的格子都變糊（`webrtc-internals` 每個 video `inbound-rtp` 的 `frameHeight` 是 180、分享是 540；統計面板「要求的層」是「低」，「模式」寫「省電模式：開」「HD 視訊：關（省電模式）」）；A 的 `outbound-rtp` `rid=f` 變成 `active: false`、送出的 `framesPerSecond` 約 15；反應不再飄（停在格子中下方）、抽屜不滑；進階噪音抑制寫「省電模式開著，…暫停」、「噪音抑制」開關恢復可按。關掉省電模式：幾秒內畫質回來（大格可能要等預算有餘裕）、HD 回來、進階噪音抑制回來。重新整理後省電模式還開著。
    - **電量提示**：Android Chrome（或筆電 Chrome）電量 ≤ 20 % 且拔掉電源進會議室：出現一次「電量不多了：可以在…開啟省電模式」，不會自己打開；插上電源或已經開著省電模式時不出現。
    - 把裝置、系統、瀏覽器版本、統計面板的負載與每一項結果寫進 PR 或 issue；**AC-6.2 要錄音比對通過；AC-6.4 要這一步的省電模式與第 21 步的 HD（上行不足）、純音訊都在兩台裝置上通過才勾**（統計面板的「模式」已經顯示這三個狀態）。

24. **多人分享、文字／動態、簡報者檢視、防鏡像（H5，AC-3.4、AC-3.5、AC-3.6、AC-3.3 的防鏡像部分）**：兩台不同的電腦（A、B，Chrome 或 Edge；能再加一台 Firefox 或 Safari 更好），再加一個 C（另一台電腦或私密視窗）；A 是主持人。電腦另開 `chrome://webrtc-internals`。
    - **文字模式可讀（AC-3.4）**：B 分享一份 1080p 的文件（小字的 PDF 或程式碼），A 全螢幕看：字清楚、捲動時不會卡住很久；`webrtc-internals` 裡 B 的 `outbound-rtp` `rid=f` 是 1920×1080 左右。
    - **動態模式與提示（AC-3.4）**：B 分享一個正在播影片的分頁（或 YouTube 視窗），維持「文字」：約 6–10 秒內提示條下面出現「分享的畫面一直在動…」，按「切到動態」：A 看到的影片明顯更順（`rid=f` 變成 1280×720、`framesPerSecond` 接近 30），切回「文字」也立刻生效、分享沒有中斷。B 分享投影片、打字、移動滑鼠時**不應該**出現提示；記下誤判或太晚的情況。
    - **多人同時分享（AC-3.5）**：B 分享中 C 也分享：沒有「接手」問題，A 的主區是 C 的、側列最前面是 B 的；A 點側列 B 的分享（或主區右上的「B 的畫面」）換到主區，重新整理 A 的分頁後還是 B 的；B 看到 C 的分享在主區、自己的只在提示條的縮圖；`webrtc-internals` 裡 A 收主區的那條 `frameHeight` 比側列那條高。A 第三個也分享後，D（第四台或私密視窗）按分享看到「已經有 3 個人在分享畫面…」。A 從參與者面板停止 B 的分享：只有 B 的停了、B 看到通知，C 的照常。
    - **簡報者檢視（AC-3.6）**：B 分享一個視窗：提示條左邊的小縮圖每秒更新一次、內容是那個視窗；B 自己的舞台從來不會滿版自己的分享。B 改分享整個螢幕：縮圖不見，換成「分享整個螢幕時不顯示預覽…」。
    - **防鏡像（AC-3.3）**：B 在選擇器裡**看不到** LongTalk 自己的分頁；B 另開一個分頁也進同一個會議，再分享那個分頁：出現「你分享的是會議室的分頁…」與「換一個畫面」，按下去選別的分頁：分享沒有中斷，A 看到的畫面換了；B 分享整個螢幕並停在會議頁 3 秒：出現「會議室就在你分享的螢幕上…」，切到別的 app 後提醒消失；「知道了」之後這個畫面不再提醒。Firefox 分享 Firefox 自己的視窗：出現「你分享的是會議室所在的視窗…」。
    - 全程**聲音不斷**，分享之間切換不重新連線；把裝置、瀏覽器版本、提示出現的秒數寫進 PR，**兩台不同裝置都對上才勾 AC-3.4、AC-3.5、AC-3.6**。

常見狀況：「媒體伺服器尚未設定」＝ secret 沒設；「媒體伺服器不認得這個分頁」＝ session token 過期（房間把成員移除了），重新整理；一直沒有對方的畫面 ＝ 網路擋 UDP，檢查 TURN secret 有沒有設（`/api/turn` 的 `turn` 要是 `true`）。

## 6. Realtime 免費額度保護（e11-t13，B1）

擁有者決定**只用免費額度**（2026-10-31）：Realtime 的 SFU 與 TURN 共用每月 1,000 GB 流出。超過就要付費，所以 LongTalk 自己記帳、提早降級：

| 這個月（UTC）的流出 | 狀態 | 會發生什麼 |
| --- | --- | --- |
| 未滿 `USAGE_LOW_QUALITY_GB`（預設 800） | `normal` | 照常 |
| 達 `USAGE_LOW_QUALITY_GB` | `low` | 房裡每個人收到通知；鏡頭改成低畫質（320×180、15 fps）送出，新進房的人一開始就是低畫質 |
| 達 `USAGE_AUDIO_ONLY_GB`（預設 950） | `audioOnly` | 代理拒絕任何**新的**視訊軌（push 或 pull 都是 403 `usage_audio_only`）；已經在送的視訊不切斷；聲音照常；介面提示「只保留聲音」 |

- **怎麼算**：`UsageDO`（`worker/usage-do.ts`，整個部署一個，`idFromName('global')`）存這個月的累計。每間有人的房間在每 15 秒的 alarm 把這段時間的兩個數字交給它，**取大的那個**加進當月總數：(1) 瀏覽器每 10 秒經房間 WebSocket 回報的 `bytesReceived`（`stats` 訊息，RoomDO 只算增量、限速 25 Mbps 防灌水）；(2) 伺服器自己的估算：經過時間 × 每個連線中成員收的每條軌 × 假設位元率（cam 1.5 Mbps、screen 2.5 Mbps、mic 64 kbps，`shared/usage.ts`）。估算不信任瀏覽器，所以不回報也躲不掉；回報抓得到估算低估的情況。
- **關掉的軌不算**（B2）：成員關掉麥克風或鏡頭時，軌還在但不送東西（`muted`），伺服器估算不算它。謊報 `muted` 卻照送的話，收的人回報的 bytes 仍然抓得到。
- **每月 1 日歸零**：以 UTC 月份為準（台灣時間每月 1 日早上 8 點）。
- **門檻設定**：`wrangler.jsonc` 的 `vars`（頂層與 `env.preview` 各一份），單位 GB（十進位）。改了要重新部署；值不合法時用預設。
- **查詢**：`GET /api/usage` → `{"month":"2026-10","bytes":123456789,"state":"normal"}`（不快取）。
- **TURN（B3）**：SFU 與 TURN 共用 1,000 GB；依 Cloudflare 定價頁，TURN 與 SFU 之間的流量不重複計費，計的是 TURN 到瀏覽器的流出（同一份媒體加上 TURN 框架，經 `turns:443` 時還有 TCP／TLS）。瀏覽器的 `stats` 帶 `relay`（選中的 candidate pair 是否走 TURN），RoomDO 對走 TURN 的接收端，兩個數字都 ×1.1（`RELAY_OVERHEAD`，`shared/usage.ts`）。
- **誤差**：這是估算，不是 Cloudflare 的帳單。真正的用量以 Cloudflare 儀表板為準，`e11-t09` 成本儀表板會拿這份計數和帳單對照。
- **重設或手動調整**：目前沒有管理介面；真的需要時把門檻 var 暫時調高或調低後重新部署。

## 7. 瀏覽器互通測試（e2-t10，B4；三人起於 #13）

`e2e/interop.spec.ts`（Playwright）：三個 Chromium 用假鏡頭、假麥克風（`--use-fake-device-for-media-stream`，會動的畫面與嗶聲），從首頁開一間房、每隔 3 秒一個經預先加入頁加入，經**真的 Realtime SFU** 檢查：

- 每個人都看到另外兩人的畫面，而且每秒解出 ≥ 5 幀；都聽得到另外兩人（`<audio>` 的音量峰值 > 0.05）。只測兩人時抓不到三人以上才出現的協商競態（見 ADR-001 Realtime API 要點）。
- 三人是同一個 Chromium 的三個 context（各自的儲存空間＝不同成員）。Chrome 的假鏡頭偶爾整個不見（`getUserMedia` 回 `NotFoundError`，畫面上是「找不到鏡頭」），那是測試環境的問題、不是 LongTalk 的；log 會印出每個人的 `getUserMedia` 失敗、PeerConnection 狀態、每個 `/api/sfu` 呼叫與送給房間的 `tracks`，看得出是哪一種。改成每人一個瀏覽器程序試過，假鏡頭不見的情況反而更常發生。
- Alice 按「靜音」：Bob 看到紅色麥克風、聲音變成靜音；按「關閉視訊」：Bob 的格子換成首字（「鏡頭沒開」）；兩個都打開：Bob 又看到、聽到她。
- Bob 靜音：Alice 看到，而且還在收他的畫面。
- **螢幕分享（D1）**：Bob 按「分享螢幕」：他看到「你正在分享畫面」條、自己維持格狀；Alice、Carol 的舞台切成分享版面、主區看到 Bob 的畫面（每秒 ≥ 3 幀）、Carol 的鏡頭在側列照常。Bob 的提示條上有自己分享的小縮圖（簡報者檢視，H5）。Carol 也按分享（H5，不問接手）：兩個分享同時在，Alice 的主區是 Carol 的（最新的）、側列最前面是 Bob 的，兩個分享的聲音都聽得到；Alice 點側列 Bob 的分享換到主區、再從主區右上的選擇鈕選回 Carol 的，主區的畫面高度大於側列的（主區 `f`、側列 `h`）；Alice 從參與者面板停止 Bob 的分享，Bob 看到「主持人 Alice 停止了你的分享畫面。」、Carol 的分享照常；Carol 在提示條切到「動態」，畫面照常；Carol 從提示條停止：三人都回到格狀。headless Chromium 沒有螢幕可擷取、也沒有選擇器可點，所以分享來源是 `addInitScript` 換掉的 `getDisplayMedia`（canvas `captureStream`，會動的畫面）；真的選擇器在 §5 第 9 步實測。
- **分享音訊（D2）**：替身 `getDisplayMedia` 在房間要求音訊時多給一條 oscillator 的音軌（當成分頁音訊）。Alice、Carol 的 `audio[data-share-audio="Bob"]` 音量峰值 > 0.05（Bob 的麥克風此時是靜音的，聲音只會來自分享音訊）；Bob 按提示條的「關閉分享音訊」→ Alice 聽到靜音、分享畫面照常；「開啟分享音訊」→ 聲音回來。Carol 也分享後 Alice 兩個分享的聲音都聽得到；主持人停止 Bob 的分享後 Bob 的分享音訊元素消失。真的分頁／系統音訊與回音在 §5 第 10 步實測。
- **聊天（D3）**：媒體檢查之前，Alice 打開聊天、送一則帶連結的中文訊息；Bob、Carol 的「聊天」鈕出現「1 則未讀」，打開後看到同一則訊息、連結是 `rel="noopener noreferrer"`，再關上（讓舞台回到全寬）。
- **等候室與鎖房（F2）**：Carol 被移出後，Alice（主持人）在參與者面板打開「等候室」；第四個 context Dave 加入：他看到等候畫面（「你是下一位」），Alice 看到「Dave 在等候室，等你放行」與琥珀色徽章，Bob 的舞台上沒有 Dave；Alice 按「放行」→ Dave 同一頁進房，Alice 與 Dave 互相收得到畫面與聲音、Dave 收得到 Bob 的畫面（Bob 前面靜音了）。Alice 打開「鎖定會議室」：三人都看到鎖頭；第五個 context 開連結直接是「這間會議室已鎖定」（沒有名字欄）。
- **離開後畫面（D4）**：最後 Carol 按「離開」：她看到「你已經離開會議室」與「重新加入」，按「5 分：很好」後出現「謝謝你的回饋！」，而且這個評分真的送到 `POST /api/events`（請求內容有 `{ "type": "rating", "score": 5 }`、回 202）；Alice、Bob 的舞台上 Carol 的格子消失。
- **進階噪音抑制（H4）**：純音訊模式那一步之後，Alice 在「更多 › 設定…」打開「進階噪音抑制」：沒有「正在載入」或錯誤提示，Bob、Carol 的 `<audio>` 仍有能量（> 0：假麥克風的嗶聲是穩定的音，RNNoise 當它是人聲留著），也就是送出去的確實是 RNNoise 處理過的那條軌；關掉後 Bob 又聽到 > 0.05。錄音比對（雜音有沒有變小）在 §5 第 23 步實測。
- **純音訊模式（H3）**：Carol 隱藏自己之後，Bob 從「更多」打開「純音訊模式」：他看到「純音訊模式：不接收也不送出視訊」，收不到 Alice、Carol 的畫面，她們也收不到他的；Bob 還聽得到 Alice。按「恢復視訊」：Bob 又收到兩人的畫面與聲音、她們又看到 Bob。
- 結束時每個人按「離開」，SFU session 立刻關閉（省額度）。

**在哪裡跑**：`preview.yml` 的 `e2e` job，在預覽部署與 smoke test 之後，`BASE_URL` 是這個 PR 的預覽網址。沒有預覽（fork、沒有 Cloudflare secret）或預覽沒有 `REALTIME_APP_ID`／`REALTIME_APP_SECRET` 時，job 留 notice 並略過（顯示成功）。每次約用數十 MB 的 SFU 流量（`longtalk-dev` app）。

**不穩的對策**：CI 重試 1 次（第二次還失敗就是真的壞了）；斷言用輪詢（每項最多 30 秒），不用固定等待；一次只跑一個測試。失敗時上傳 `e2e` artifact（`test-results/` 的 trace、影片、每個人的截圖，`playwright-report/`），用 `npx playwright show-trace <trace.zip>` 看。

**本機跑**：

```bash
npx playwright install chromium        # 第一次
BASE_URL=https://longtalk-pr-<號>.genelee-pro.workers.dev npm run test:e2e
PW_CHANNEL=chrome BASE_URL=… npm run test:e2e   # 用已安裝的 Chrome，不下載 Chromium
```

`BASE_URL` 必須是有 SFU secret 的部署（PR 預覽或正式站）；`npm run dev` 的本機 Worker 沒有 secret，媒體連不上。`npm test`（Vitest）只跑 `tests/`，不會撿到 `e2e/`。

**是不是必過的檢查**：目前不是（`main` 的保護只要求 `CI / verify`）。它依賴 Cloudflare 與 SFU secret，fork 的 PR 也不會跑；穩定跑過幾個 PR 後，可以在分支保護加上 Preview workflow 的 `e2e`（略過時算通過）。

### 不需要部署的檢查：無障礙與視覺回歸（G5，`e4-t14`、`e4-t17`）

`.github/workflows/ui.yml`（`UI checks`）在每個 PR 與 `main` 上跑，**不用 Cloudflare 帳號**：`npm run build` 之後用 `vite preview` 在 workerd 裡跑整個 Worker（API、Durable Objects、靜態資產），房間照常運作，只是沒有 Realtime SFU（會議室顯示「媒體伺服器尚未設定」）。兩個 job 都在 **Playwright 的 Docker image**（`mcr.microsoft.com/playwright:v1.64.0-noble`，版本要和 `package.json` 的 `@playwright/test` 一樣；升級 Playwright 時兩處一起改，並重做基準截圖）裡跑，字型與繪製每次一樣。設定在 `playwright.local.config.ts`，測試在 `e2e/local/`。

- **`a11y`**：`e2e/local/a11y.spec.ts` 用 axe-core（`@axe-core/playwright`，WCAG 2.2 A／AA＋best practice）掃首頁（深淺色、錯誤訊息）、預先加入、`/admin`、會議室（兩人）、聊天側欄、參與者面板與對某人的選單、反應選擇器、「更多」、快捷鍵清單、離開確認、設定面板的三個分頁（會議室與預先加入頁，H3）、手機的會議室與抽屜（含設定抽屜）、等候室（等候者與主持人的名單）、離開後畫面、密碼與改名對話框、英文介面；**一個違規就失敗**。另外用鍵盤走一遍：名字欄先有焦點、Enter 進房、Tab 到格子的「釘選」、反應選擇器、參與者選單（Esc 後焦點回原處）、每個可聚焦的元素都有 2 px 外框。接著 `scripts/lighthouse.ts`（`npm run lighthouse`）用 Lighthouse 13 量首頁、預先加入（navigation）與會議室（加入後 snapshot）在桌機與手機的無障礙分數，**任何一個 < 0.95 就失敗**；分數表在這次 run 的 Summary，HTML 報告在 `a11y` artifact。2026-11-03（#30）CI：六個都是 1.00。
- **進階噪音抑制（H4）**：`e2e/local/noise.spec.ts` 在 `a11y` job 裡跟著跑（同一個 `test:ui`）：進房時沒有載入任何 RNNoise 的東西；打開「進階噪音抑制」後，管線的 chunk 與 wasm 從自己的 `/assets/` 載入、沒有錯誤提示、不是卡在「正在載入」，瀏覽器的噪音抑制開關變灰；再開省電模式，它暫停、瀏覽器的開關回來、`<html data-motion="off">`。
- **`visual`**：`e2e/local/visual.spec.ts` 截首頁、預先加入、會議室 × 淺色／深色 × 桌機（1280×800）／手機（390×844）共 12 張，和 `e2e/local/__screenshots__/` 的基準比（差異超過 0.1% 像素就失敗）。為了每次都一樣：假鏡頭換成一張靜止畫面、假麥克風是靜音（`e2e/local/fakeMedia.ts` 產生的 Y4M 與 WAV，`--use-file-for-fake-*-capture`），名字固定（Ada），`reducedMotion: reduce`＋截圖時停掉動畫、藏游標，會變的東西蓋掉（房間代碼、會議時鐘、以檔案路徑命名的鏡頭選單），預先加入頁等「沒有偵測到聲音」出現後才截（固定 6 秒後）。會議室一律深色，所以它的淺色截圖是在確認「系統是淺色時會議室仍是深色」。
- **不是必過的檢查**：`main` 的保護仍只要求 `CI / verify`。這兩個 job 沒有外部依賴、跑過幾次都很穩，觀察幾個 PR 後可以在分支保護加上 `UI checks / a11y` 與 `UI checks / visual`。

**更新視覺基準**（介面本來就要變的時候）：

1. 推上分支，`visual` 失敗時會上傳兩個 artifact：`visual-diff`（每張變了的截圖的 expected／actual／diff，看看是不是只變了該變的）與 `visual-baselines`（整套新的基準）。
2. 確認變化是對的之後：`gh run download <run id> -n visual-baselines -D e2e/local/__screenshots__`（覆蓋舊檔），commit、推上去，`visual` 就會過。
3. 想直接要一套新的（例如升級 Playwright 後）：Actions › UI checks › Run workflow，勾 `update`（這個 workflow 在 `main` 上才能手動跑）；或在有 Docker 的機器上：`docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.64.0-noble bash -c "npm ci && npm run build && npx playwright test -c playwright.local.config.ts visual.spec.ts --update-snapshots"`。**不要用 Windows 或 Mac 產生的截圖當基準**（字型與反鋸齒不同，CI 一定失敗）；在非 Linux 上 `visual` 預設略過（`VISUAL=1` 可以強制跑，只用來看畫面）。

**本機跑**：

```bash
npx playwright install chromium        # 第一次
npm run build && npm run test:ui       # axe、鍵盤（visual 在 Windows／Mac 上略過）
npx vite preview --port 4173 &  npm run lighthouse   # 另一個終端機也可以
```

`test:ui` 自己會起 `vite preview`（本機已經有一個在 4173 就直接用它）。**改了程式要重新 build**，而且已經開著的 `vite preview` 要關掉重開：它不會看到新的檔案（舊的 workerd 程序還在時，頁面的 JS 會回 `text/html`、畫面一片空白）。

## 8. 最小遙測與 `/admin`（e11-t03，D3）

擁有者決定（2026-11-02）：**自架、不用第三方帳號（不用 Sentry）、只用免費額度**。所以遙測全部在自己的 Worker 裡：

| 部分 | 在哪裡 | 做什麼 |
| --- | --- | --- |
| 事件 API | `POST /api/events`（`worker/events.ts`，格式 `shared/telemetry.ts`） | 瀏覽器每 10 秒（或離開頁面時用 `sendBeacon`）送一批 ≤ 20 個事件、≤ 8 KB；只接受同站（`Origin`）；每個用戶端（IP 的雜湊，不存 IP）每 10 分鐘最多 60 個事件、其中錯誤 10 個、評分 3 個，超過回 429 |
| 計數 | `TelemetryDO`（全站一個，`worker/telemetry-do.ts`、`worker/telemetry.ts`） | 每小時（留 48 小時）與每天（留 90 天，資料保留表的遙測 90 天）的計數，最近 20 種用戶端錯誤；每批事件在回應前就寫進 storage（2026-11-03 修正：原本 30 秒後由 alarm 寫，DO 閒置約 10 秒就可能離開記憶體，最後幾個事件（例如離開時的評分）會遺失） |
| Analytics Engine | 綁定 `EVENTS`（`wrangler.jsonc`；正式站 dataset `longtalk_events`、預覽 `longtalk_events_preview`）。**目前註解掉**，等擁有者在帳號啟用 Analytics Engine（下方） | 每個收下的事件寫一個 data point，之後要細查時用 SQL API；**`/admin` 不需要它**，沒有綁定時 Worker 只是不寫 |
| `/admin` | `src/pages/AdminPage.tsx`（lazy chunk，不在首頁與會議室的 JS 裡）＋ `GET /api/admin/summary` | 輸入 `ADMIN_TOKEN` 才看得到：近 24 小時／7 天的進房數與成功率、失敗原因、重新連線（房間連線／媒體連線）、媒體重建、經由 TURN 的比例、用戶端錯誤、離開評分（平均與 1–5 分的分布；每日表有平均）、每日表、最近的錯誤、本月 Realtime 流量；最上方是**警示** |

**記哪些事件**：進房成功／失敗（原因：找不到房間、房間已滿、版本過舊、連不上、被另一分頁取代）、重新連線（房間 WebSocket 或媒體）、媒體重建、媒體 session 連上 15 秒後是否走 TURN（算 TURN 比例）、未攔截的錯誤與 Promise rejection（每頁最多 5 種、同一種只報一次、名稱與訊息截短並去掉網址、e-mail、長數字、房號；Worker 收到後再清一次；抽樣比例 `ERROR_SAMPLE_RATE` 目前是 1，量大再調低）。離開評分（D4 `e4-t18`：離開後畫面的一題 1–5 分，只有分數，沒有文字、房號或成員；一次離開最多評一次）。**不記**名字、房號、聊天內容、IP。加新的事件種類時，Worker 不認得的事件只丟掉那一個、不會讓整批失敗，所以可以先部署瀏覽器。本機開發（`npm run dev`）與測試不送事件。

**警示（目前的做法）**：沒有 Email、沒有 webhook（都要另外的服務或帳號）；`/admin` 最上方用紅字列出：(1) 這個小時加上一個小時，用戶端錯誤 ≥ 20 次；(2) 近 24 小時進房 ≥ 10 次、其中失敗 ≥ 20%。門檻在 `shared/telemetry.ts`。要主動通知的話，之後可以用 Cron Trigger 檢查同一份 summary，再寄到擁有者的信箱（Email Routing 免費）——那是 `e11-t09` 的範圍。

### 擁有者要做的事

1. 產生一個長亂數當密碼，設成**正式 Worker** 的 secret（不要用跟別的地方一樣的密碼；不會出現在 repo、前端或網址裡）：

   ```sh
   openssl rand -base64 32          # 或任何密碼產生器
   npx wrangler secret put ADMIN_TOKEN
   ```

   沒設定時 `/api/admin/summary` 回 503，`/admin` 顯示「這個部署還沒設定管理密碼」；其他功能不受影響。
2. （選用）PR 預覽也要能看 `/admin`：在 GitHub 設 `PREVIEW_ADMIN_TOKEN`（`gh secret set PREVIEW_ADMIN_TOKEN`，用**另一個**亂數），`preview.yml` 部署後會把它寫成該 PR Worker 的 `ADMIN_TOKEN`；沒設就跳過（notice）。
3. 打開 `https://<站>/admin`，輸入密碼。密碼只放在這個分頁的記憶體裡（重新整理就要再輸入一次），以 `Authorization: Bearer …` 標頭送出，**不會放在網址**；Worker 用常數時間比對（兩邊先 SHA-256 再 `timingSafeEqual`）。目前沒有猜密碼的次數限制，所以密碼一定要夠長（32 個字元以上的亂數）。

### Analytics Engine（選用的細查）

Analytics Engine 在 Workers 免費方案可用（有每日寫入額度，M0 的量遠低於它，以 Cloudflare 定價頁為準），但**帳號要先啟用一次**：D3 的 PR 預覽帶著綁定部署時，Cloudflare 回 `You need to enable Analytics Engine`（code 10089），所以綁定先註解掉，部署與 `/admin` 都不受影響。要打開：

1. 擁有者到 Cloudflare 儀表板 → Workers & Pages → **Analytics Engine**（`https://dash.cloudflare.com/<ACCOUNT_ID>/workers/analytics-engine`）按啟用（免費方案可用，不用付款資訊；畫面若要求升級付費方案就先不要開，`/admin` 照常用 `TelemetryDO`）。
2. 開一個 PR，把 `wrangler.jsonc` 裡兩行 `analytics_engine_datasets`（頂層與 `env.preview`）的註解拿掉；PR 預覽部署成功、`/admin` 底下顯示「事件也寫進 Workers Analytics Engine」就是好了。dataset 在第一次寫入時自動建立。

要用 SQL 查，需要一個有 **Account Analytics: Read** 權限的 Cloudflare API token（**不是** Worker secret，只在擁有者自己的電腦用；LongTalk 不需要它也能運作）：

```sh
curl "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/analytics_engine/sql"   -H "Authorization: Bearer <分析用的 API token>"   -d "SELECT blob1 AS type, blob2 AS detail, SUM(_sample_interval) AS n
      FROM longtalk_events
      WHERE timestamp > NOW() - INTERVAL '1' DAY
      GROUP BY type, detail ORDER BY n DESC"
```

欄位：`index1`／`blob1` 事件種類（`join`、`reconnect`、`rebuild`、`media`、`error`、`rating`）；`blob2` 細節（`join`：`ok` 或失敗原因；`reconnect`：`socket`／`media`；`media`：`relay`／`direct`；`error`：`error`／`rejection`；`rating`：分數 `1`–`5`）；`blob3`–`blob5` 錯誤的名稱、訊息、來源檔；`blob6` 版本（commit）；`double1` = 1。預覽的資料在 `longtalk_events_preview`。資料保留 3 個月（Analytics Engine 的預設）。

## 9. 品牌檔案：favicon、App 圖示、OG 圖、manifest（e4-t19，D4）

名稱只用英文 **LongTalk**（PRD §14、DESIGN §7）：標誌、圖示、manifest 的 `name`／`short_name`、`<title>`、Open Graph 標題與圖片都沒有中文名。說明文字（`description`、`og:description`）是介面文字，用繁體中文。

| 檔案（`public/`） | 從哪裡來 | 用途 |
| --- | --- | --- |
| `favicon.svg` | `docs/design/logo/favicon.svg` 原樣複製 | 分頁圖示（支援 SVG 的瀏覽器） |
| `favicon.ico`、`icons/favicon-32.png` | `favicon.svg` 32 px（ICO 裡包一張 PNG） | 不吃 SVG 的瀏覽器、會自己去要 `/favicon.ico` 的爬蟲 |
| `apple-touch-icon.png` | `favicon.svg` 拿掉圓角、180 px | iPhone／iPad「加入主畫面」（iOS 自己切圓角） |
| `icons/icon-192.png`、`icon-512.png` | `favicon.svg`（圓角方塊） | manifest `purpose: any` |
| `icons/icon-maskable-192.png`、`icon-maskable-512.png` | `icon-maskable.svg`（滿版、圖在中央安全區） | manifest `purpose: maskable`（Android 依系統形狀裁切） |
| `og-image.png` | 1200×630：品牌藍綠底、白色標誌、「LongTalk」與英文標語「The meeting room that never cuts out」 | 貼連結到 LINE、Messenger、Slack、X 時的預覽圖 |
| `manifest.webmanifest` | `src/brand.ts` 的 `webManifest()` | `name`／`short_name` 都是 LongTalk，`display: standalone`，顏色是 `tokens.ts` 的深色背景（會議室一律深色） |
| `_headers` | 手寫 | 快取標頭（下方） |

- **重新產生**：改了 `docs/design/logo/*.svg`、`src/brand.ts` 或 `tokens.ts` 的顏色後跑 `npm run brand`（用 Playwright 已安裝的 Chromium 把 SVG 畫成 PNG；沒有的話先 `npx playwright install chromium`），把 `public/` 的變動一起提交。OG 圖的字用品牌字體 `Inter`，沒有就用系統的無襯線字，所以不同電腦產生的 OG 圖可能有一點差異；其他圖示只有圖形，結果一樣。`tests/shared/brand.test.ts` 會檢查 `public/` 與 `index.html` 跟 `src/brand.ts` 一致（manifest、每張圖的尺寸、meta 標籤、名稱沒有中文字）。
- **`index.html` 的標籤**：`favicon.ico`＋`favicon.svg`、`apple-touch-icon`、`manifest`、兩個 `theme-color`（淺色／深色跟系統，取 `tokens.ts` 的 `bg`）、`description`、`og:*`、`twitter:card`（`summary_large_image`）。**`og:image` 必須是絕對網址**，寫死正式站 `https://longtalk.genelee-pro.workers.dev/og-image.png`（PR 預覽也指向正式站的圖）；換網域時改 `src/brand.ts` 的 `SITE_URL` 與 `index.html`，測試會比對兩者。
- **快取**（`public/_headers`，Workers Static Assets 會讀它、不會把它當檔案送出）：圖示與 OG 圖 1 天、manifest 1 小時（並明確給 `Content-Type: application/manifest+json`）；其他檔案維持預設（每次用 ETag 驗證）。**不給 `/assets/*` 長快取**：雖然 Vite 的檔名帶雜湊，但部署後舊分頁要的舊 chunk 已經不在，會落到 single-page-application 的 `index.html`，那個回應不能用 chunk 的名字快取一年。
- **service worker**（G4 起）：離線殼、安裝提示、新版本提示見 §10。`/sw.js` 由 build 產生（不在 `public/`），`_headers` 給它 `Cache-Control: no-cache`。
- **部署後檢查**：`scripts/smoke.sh` 在每次預覽與正式部署後確認這些檔案回 200 且型別正確（`image/svg+xml`、`image/png`、`application/manifest+json`），manifest 寫的是 LongTalk，首頁連到 manifest。

## 10. PWA：service worker、安裝與新版本提示（e4-t12，G4）

**只是 App 殼**：讓首頁與房間連結在離線時也打得開（進房仍然需要網路），並在部署後讓還開著的分頁知道有新版本。它不碰任何即時的東西。

- **怎麼產生**：`src/pwa/sw.ts`（handler 在 `swWorker.ts`、規則在 `swRouting.ts`，純函式、`tests/app/pwa.test.tsx` 測）由 `scripts/swPlugin.ts` 在 `vite build` 時打包成 `dist/client/sw.js`（經典 script，不是 module worker），前面加一行 `self.__LT_SW__={version, appVersion, precache}`。`precache` 是 `/`（`index.html`）、這一版 `assets/` 下所有 JS／CSS、`favicon.svg`、`favicon.ico`、`manifest.webmanifest`，排序後固定；`version` 是「清單＋拿掉 app-version 的 `index.html`＋worker 程式」的雜湊，**同樣的原始碼得到同樣的 `sw.js`**（只有 `appVersion` 跟著 commit 變）。手寫而不用 vite-plugin-pwa／Workbox：只需要三種策略、約 2.6 kB、沒有新相依（不用追 Vite 8 與 Cloudflare 外掛的相容性），「不碰 `/api`」這條規則在自己的測試裡。`swRouting.ts`、`swWorker.ts` 只能被 `sw.ts` 匯入（app 匯入會被拆成共用 chunk，build 會失敗並說明）。
- **策略**：頁面載入（`navigate`）**網路優先**，連不上才給這一版快取的 `/`；`/assets/*` 快取優先（檔名帶雜湊，同名永遠同內容）；其他同網域檔案網路優先、離線用快取。**一律不碰**：`/api/*`（開房、房間資訊、SFU 代理、TURN 憑證、遙測、`/api/health`）、WebSocket（瀏覽器本來就不經過 service worker）、其他網域、非 GET、`/sw.js` 本身；也從不把 `/api` 的回應存進快取（`mayCache`）。
- **版本與快取**：每一版一個 `longtalk-shell-<version>` 快取。新版**不自動接手**（沒有 `skipWaiting`），等使用者按「重新整理」或舊版的分頁全部關掉；接手（activate）時刪掉「這一版與前一版」以外的 shell 快取，**前一版多留一代**：部署後還在開會的舊分頁，之後要載入的 lazy chunk 伺服器上已經沒有了，仍可從前一版的快取拿到（不會跳出「載入失敗」）。真的拿不到時照舊是 `e4-t20` 的「載入失敗，請重新整理」。
- **新版本提示**（`src/pwa/update.ts`）：分頁回到前景、網路恢復、每 30 分鐘請瀏覽器檢查 `/sw.js`；新的 worker 裝好在等待時，問它帶來哪個 build：**頁面已經是那一版**（例如剛從網路載入新的 `index.html`）或**檔案完全一樣**（只改文件的部署）就安靜地接手，否則顯示「有新版本，重新整理」卡片（左下角、不擋畫面、會議室裡說「重新整理後會直接回到這場會議」）。**從不自己重新整理**；「稍後」之後，下一次在 app 裡換頁（例如離開會議回首頁）才套用。沒有 service worker 的瀏覽器（Firefox 私密視窗、http）改比對 `/api/health` 與 `<meta name="app-version">`。本機 `local` 版本不提示。
- **安裝提示**（`src/pwa/install.ts`）：只在首頁。Chromium 的 `beforeinstallprompt` 被留下來給自己的「安裝」按鈕；iPhone／iPad Safari（`navigator.standalone` 存在）顯示一次「分享 › 加入主畫面」；已經以 App 打開（`display-mode: standalone`）、按過「不用了」、或瀏覽器回報已安裝就不再出現（`localStorage` 的 `longtalk.installDismissed`）。
- **PR 預覽**：每個預覽是自己的 `longtalk-pr-<號>` 網域，service worker 與快取各自獨立，不會和正式站互相影響；`vite dev` 不註冊 service worker（`import.meta.env.PROD`）。e2e 的 `e2e/pwa.spec.ts` 在預覽上檢查：worker 註冊並接管、快取裡有殼而沒有 `/api`、`/api/health` 不經過 worker、離線時首頁與房間連結的畫面；`scripts/smoke.sh` 檢查 `/sw.js`（§2）。
- **出問題時**：要讓所有人立刻丟掉 service worker，部署一版 `sw.ts` 只在 `activate` 時刪掉全部 `longtalk-shell-*` 並 `self.registration.unregister()`（瀏覽器每次載入都會重新檢查 `/sw.js`，`no-cache`）。使用者端：網站設定 › 清除資料，或 DevTools › Application › Service workers › Unregister。

## 11. 濫用防護與安全標頭（e11-t05、e11-t06，I1）

**只用免費方案**：限制都在自己的 Worker 與 Durable Object 裡，不用 Cloudflare 的 WAF 規則或付費的 Rate Limiting。Workers 的 Rate Limiting 綁定（`ratelimits`）官方文件沒寫免費方案能不能用、只有 10／60 秒兩種週期、每個機房各算各的，所以**沒有用**；跨機房、以天計的建房限制要全站一致，放在 `GuardDO`（一次建房一次 DO 請求，免費方案每天 10 萬次）。

### 限制一覽（數字在 `shared/abuse.ts`）

| 什麼 | 上限 | 超過時 | 在哪裡算 |
| --- | --- | --- | --- |
| 建房（每個網路） | 10 分鐘 10 間、一天 60 間 | 429 `rate_limited`＋`Retry-After`；首頁「這個網路開房的次數太多了，請 N 分鐘後再試」 | `GuardDO`（全站） |
| Turnstile（建房） | 兩把 key 都設了才開 | 403 `turnstile_required`（附 site key）→ 瀏覽器跑 widget 再送；驗證沒過 403 `turnstile_failed` | Worker → siteverify |
| `/api/rooms/<id>` 與 WebSocket 升級（每個網路） | 每個 isolate 10 秒 60 次 | 429 | Worker 記憶體（第一道防線） |
| 進同一間房的升級（每個網路） | 每分鐘 60 次 | WebSocket 以 4420 關閉，瀏覽器不重連、請使用者等一分鐘再重新整理 | RoomDO |
| 每個連線的訊息（全部種類合計） | 10 秒 120 個（心跳 `ping` 由 runtime 自動回，不算） | 4420 關閉，那位成員變成「重新連線中」，寬限期滿被移除 | RoomDO |
| 單一訊息大小 | 16 384 字元（`MAX_CLIENT_MESSAGE_CHARS`） | 1009（Message Too Big）關閉 | RoomDO |
| 原有的：聊天、反應、訊號、密碼 | 每人 10 秒 10 則、5 秒 8 個、10 秒 3 個；密碼錯 3 次等 30 秒 | 不變 | RoomDO |
| 封鎖名單 | 擁有者在 `/admin` 設定，1 小時／1 天／7 天／30 天 | `/api/rooms/*` 一律 403 `blocked`（首頁與預先加入頁說「這個網路目前不能開房／加入會議室」）；已經在會議裡的連線不受影響 | `GuardDO`，Worker 每 30 秒讀一次 |

- **網路**＝IPv4 的一個位址、IPv6 的一個 /64（一個家庭或一支手機通常拿到整個 /64）。只存雜湊（96 bits），從不存位址；有 `IP_HASH_PEPPER` 時是以它為 key 的 HMAC，沒有時是一般 SHA-256（IPv4 只有 2³² 個，拿到 storage 的人可以窮舉回推，所以建議設 pepper）。
- **同一個網路的人一起算**：公司、學校、宿舍的 NAT 後面的人共用額度與封鎖。數字設得讓一整間辦公室同時進房、斷線重連都碰不到；要調整改 `shared/abuse.ts`。
- 沒有 `CF-Connecting-IP` 的請求（本機 `npm run dev`／`vite preview`、單元測試）**不受**這些限制。
- `/admin` 的「濫用防護與封鎖名單」：Turnstile 與 pepper 有沒有開、封鎖中的雜湊與到期時間、輸入 IP 封鎖（Worker 雜湊後才存）、最近碰到限制的網路（開房太多、驗證沒過、連線太多、訊息太多）可以一鍵封鎖 1 天、解除封鎖。API：`POST /api/admin/blocks`（`{ ip | key, hours, note? }`）、`DELETE /api/admin/blocks/<key>`，都要 `ADMIN_TOKEN`。

### 擁有者要做的事（Turnstile 與 pepper；都可以晚點做，沒做之前什麼都不會壞）

1. **建立 Turnstile widget**：Cloudflare 儀表板 → Turnstile → Add widget。名稱 `LongTalk`；Hostname 加 `longtalk.genelee-pro.workers.dev`（之後有自訂網域也加上）；Widget mode 選 **Managed**（LongTalk 用 `interaction-only` 外觀：大部分人什麼都看不到，需要時才出現勾選框）；Pre-clearance 選 No。建立後拿到 **Site Key** 與 **Secret Key**。PR 預覽（`longtalk-pr-<號>.genelee-pro.workers.dev`）**不需要**加進 hostname：預覽用 Cloudflare 公開的測試 key（下面）。
2. **secret key 放進正式 Worker**（不要貼到任何檔案、PR 或對話裡）：

   ```sh
   npx wrangler secret put TURNSTILE_SECRET_KEY
   ```

3. **site key 寫進 `wrangler.jsonc` 頂層的 `vars`**（它是公開的，瀏覽器本來就看得到），開一個 PR 合併：

   ```jsonc
   "vars": {
     "USAGE_LOW_QUALITY_GB": "800",
     "USAGE_AUDIO_ONLY_GB": "950",
     "TURNSTILE_SITE_KEY": "<site key>"
   },
   ```

   不要在儀表板設這個 var：每次 `wrangler deploy` 會用 `wrangler.jsonc` 的 vars 蓋掉儀表板的。**兩把都設了 Turnstile 才會開**；只設一把等於沒開（`/admin` 會顯示「Turnstile 未設定」）。
4. （建議）**pepper**：`openssl rand -base64 32`，然後 `npx wrangler secret put IP_HASH_PEPPER`。設了之後不要再換：換了之後既有的封鎖與建房計數都對不上（等於全部清空）。最好在第一次封鎖任何人之前就設好。
5. 檢查：開首頁按「開一間房」，DevTools 的 Network 先看到一個 403 的 `POST /api/rooms`（`turnstile_required`），接著載入 `challenges.cloudflare.com` 的 script，第二個 `POST /api/rooms` 回 201；`/admin` 顯示「開房需要 Turnstile 真人驗證」。

**PR 預覽**用 Cloudflare 文件裡的公開測試 key（`wrangler.jsonc` 的 `env.preview.vars`）：site key `1x00000000000000000000BB`（隱形、永遠通過），secret key `1x0000000000000000000000000000000AA`（永遠通過；公開的測試值，不是 secret）。所以每個預覽都走完整的「403 → Turnstile → 201」流程，`e2e` 的瀏覽器測試也是。**真的 key 永遠不要放進 `env.preview`**。驗證失敗的情境由單元測試（假的 siteverify）負責。

### 安全標頭與 CSP

頁面與所有靜態檔（`public/_headers` 的 `/*`，內容＝`shared/security-headers.ts` 的 `PAGE_HEADERS`，`tests/app/security.test.ts` 比對）：

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com;
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self';
  connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-src https://challenges.cloudflare.com;
  frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self';
  report-uri /api/csp-report; report-to csp
Reporting-Endpoints: csp="/api/csp-report"
Strict-Transport-Security: max-age=31536000; includeSubDomains
Permissions-Policy: camera=(self), microphone=(self), display-capture=(self), autoplay=(self),
  clipboard-write=(self), fullscreen=(self), picture-in-picture=(self), accelerometer=(), bluetooth=(),
  browsing-topics=(), geolocation=(), gyroscope=(), hid=(), idle-detection=(), local-fonts=(),
  magnetometer=(), midi=(), otp-credentials=(), payment=(), screen-wake-lock=(), serial=(), usb=(),
  window-management=(), xr-spatial-tracking=()
Cross-Origin-Opener-Policy: same-origin
Referrer-Policy: strict-origin-when-cross-origin
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
```

（CSP 與 Permissions-Policy 實際上各是一行。）為什麼這樣：

- **script**：只有自己的檔案，沒有 inline、沒有 `eval`（Vite build 的 `index.html` 沒有 inline script）。`'wasm-unsafe-eval'` 只允許編譯 WebAssembly（RNNoise，`e6-t02`），不是 JavaScript 的 eval。Turnstile 的網域**一律列著**：頁面由靜態資產直接回應、標頭是固定的，沒辦法照「有沒有設定 key」變；它是 Cloudflare 自己的網域，沒設定 key 時頁面根本不會載入它。
- **style 允許 `'unsafe-inline'`**：styled-components 在執行時寫 `<style>`，React 的 `style={…}` 與 `index.html` 的 `<body style>` 也是 inline style。要改用 nonce 得讓每個 HTML 回應都經過 Worker 改寫（每次開頁多一次 Worker 請求），不划算；inline style 不能執行程式，風險比 inline script 低很多，script 那邊維持嚴格。
- **connect 只有 `'self'`**（CSP 3 的 `'self'` 也涵蓋同主機的 `wss:`，Safari 17+ 也是）：瀏覽器**不直接**連 `rtc.live.cloudflare.com`：SFU API 走 Worker 代理（`/api/sfu/*`）、TURN 憑證走 `/api/turn/*`；媒體本身是 ICE（UDP／TURN），不受 CSP 管。
- **img／media 加 `data:` `blob:`**：喇叭測試音（blob WAV）、統計匯出、內嵌的小圖。**worker 只有 `'self'`**：`/sw.js` 與 RNNoise 的 AudioWorklet 模組（`/assets/`）。
- **COOP `same-origin`**：LongTalk 不開彈出視窗、不需要和其他網域的視窗互相操作；Turnstile 是 iframe 不是彈窗，Capture Handle（分享分頁時認出會議分頁）不受影響。沒有加 COEP（會擋 Turnstile 的 iframe，也用不到 SharedArrayBuffer）。
- **Permissions-Policy** 只列 Chromium 認得的功能（認不得的會在主控台報錯：`web-share` 就是，所以沒列，維持瀏覽器預設），沒列的也維持預設（例如喇叭選擇、之後 I2 的 passkey）。
- Worker 自己的回應（`/api/*`）是 JSON，另外加 `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`、HSTS、nosniff、Referrer-Policy、`X-Frame-Options`（`worker/headers.ts`）；WebSocket 升級不動。
- **CSP 違規回報**：瀏覽器把被擋的東西 POST 到 `/api/csp-report`（`report-uri` 與 Reporting API 兩種格式都收），Worker 轉成遙測的錯誤事件：名稱 `CSP`、訊息「`<指令> blocked <網域或 inline／eval>`」、來源是頁面路徑（房號去掉），和其他用戶端錯誤一樣在 `/admin`「最近的錯誤」、受同一個速率限制。部署後出現新的 `CSP` 錯誤就是有東西被擋了。
- **檢查**：`scripts/smoke.sh` 每次部署後確認首頁與 `/api/health` 帶著這些標頭；`e2e/local/security.spec.ts`（`vite preview`）確認每個路徑的標頭，以及首頁 → 預先加入（含喇叭測試音）→ 會議室 → RNNoise（worklet＋wasm）→ `/admin`、service worker 註冊都沒有任何 CSP 或 Permissions-Policy 錯誤，別的網頁也框不住會議室。

### CI 的檢查

- **secrets lint**（`scripts/secrets.ts`）：`npm run lint` 掃 `src/`、`public/`、`index.html`（註解不算），`npm run budget` 再掃 build 出來的 `dist/client/`。擋：Worker 與 CI 的 secret 名稱（`REALTIME_APP_SECRET`、`REALTIME_TURN_KEY_ID`、`REALTIME_TURN_KEY_API_TOKEN`、`ADMIN_TOKEN`、`PREVIEW_ADMIN_TOKEN`、`TURNSTILE_SECRET_KEY`、`IP_HASH_PEPPER`、`CLOUDFLARE_API_TOKEN`）、私鑰、AWS／GitHub／Slack／AI／Google 的 key、JWT、Turnstile secret key（含測試用的）、名字像 secret 的變數被指定成長字串、`dist/client` 裡的 `.env`／`.dev.vars`。真的需要的那一行在行尾寫 `// secret-ok: <理由>`。（`/admin` 的說明文字因此不再寫出 `ADMIN_TOKEN` 這個名字。）
- **npm audit**（`ci.yml`）：`npm audit --omit=dev --audit-level=high`，正式相依（React、router、styled-components、RNNoise）有 high／critical 就失敗；全部相依的報告寫進 run 的 summary、不失敗（目前 5 個 moderate，都在 Lighthouse 的開發相依）。
- **濫用測試**（`preview.yml` 的 `abuse` job，`scripts/abuse.ts`）：瀏覽器測試跑完後對這個 PR 的預覽打：沒有 token 建房要 403、連續建房到第 11 次 429、一個 socket 一次送 141 個訊息被 4420 關掉、一個超大訊息被 1009 關掉、連續升級進同一間房被擋、120 個同時查詢、頁面的安全標頭；有 `PREVIEW_ADMIN_TOKEN` 時再封鎖自己的網路、確認 403、解除。約一分鐘、幾百個小請求。**不要對正式站跑**（腳本會拒絕；會用掉這個網路一天的建房額度）。
