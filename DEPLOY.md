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
| `ci.yml` | 每次 push、每個 PR | `npm ci` → lint → typecheck → test → build → JS 預算（首頁 ≤ 150 kB、會議室 ≤ 350 kB gzip）。全綠才可合併（AC-11.2） |
| `preview.yml` | PR 開啟、更新 | 部署 `longtalk-pr-<號>`（`CLOUDFLARE_ENV=preview`），smoke test，把網址留言在 PR；接著 `e2e` job 在這個預覽跑三個瀏覽器的互通測試（§7）；PR 關閉時刪除該 Worker 與它的資料 |
| `deploy.yml` | CI 在 `main` 綠了之後 | 部署正式站 `longtalk`，smoke test 確認它正在提供這個 commit |

smoke test（`scripts/smoke.sh`）檢查三件事：首頁 `<meta name="app-version">` 是這個 commit、`/api/health` 回這個 commit、`/r/<id>` 回 200（SPA fallback）。

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

- `wrangler.jsonc` 的 `migrations` **只能往後加**；已部署的 migration 不要改、不要刪。新增 DO class 就加一個新 tag。現有：`v1` `RoomDO`（A1）、`v2` `UsageDO`（B1，§6）、`v3` `TelemetryDO`（D3，§8）；下一個是 `v4`。
- `vars` 也**不會繼承**：頂層與 `env.preview` 各寫一次（現有 `USAGE_LOW_QUALITY_GB`、`USAGE_AUDIO_ONLY_GB`，§6）。
- `env.preview` **不會繼承**頂層的綁定：每個 DO、KV、R2、D1、Analytics Engine 綁定都要在 `env.preview` 重寫一次；R2／D1／Analytics Engine 要給預覽自己的資源，不要指到正式站的（Analytics Engine：正式站 `longtalk_events`、預覽 `longtalk_events_preview`，§8）。
- secret（SFU App token、TURN key、AI 金鑰）只用 `wrangler secret put` 放在 Worker，**不進前端、不進 repo**（CLAUDE.md 規則 3）。要設定的 secret 見 §5。

## 5. Secrets 與 Realtime 互通測試（A2，B1 起改用會議室頁）

### 要設定的 secret

| 名稱 | 放哪裡 | 從哪裡拿 | 誰用 |
| --- | --- | --- | --- |
| `REALTIME_APP_ID` | Worker secret | Cloudflare 儀表板 → Realtime → SFU → 建立 app → **App ID** | `worker/sfu.ts`（A2 起） |
| `REALTIME_APP_SECRET` | Worker secret | 同一個 app 的 **App Secret**（API token；只顯示一次） | `worker/sfu.ts`（A2 起） |
| `REALTIME_TURN_KEY_ID` | Worker secret | 儀表板 → Realtime → TURN → 建立 key → **Turn Token ID** | `worker/turn.ts`（B3 起） |
| `REALTIME_TURN_KEY_API_TOKEN` | Worker secret | 同一個 TURN key 的 **API token**（只顯示一次） | `worker/turn.ts`（B3 起） |
| `ADMIN_TOKEN` | Worker secret | 自己產生的長亂數（例如 `openssl rand -base64 32`），當成 `/admin` 的密碼 | `worker/events.ts`（D3 起，§8） |

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
   - A 分享中 B 按「分享螢幕」：出現「接手分享？」；按「取消」什麼都不變；再按一次選「接手分享」→ 選擇器 → A 的分享停止並看到「B 接手了分享」、大家看到 B 的畫面。
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
    - 三條停止路徑（提示條、工具列、瀏覽器原生「停止分享」）與 B **接手分享**：每次 A 的分享音訊都跟著停（B 不再聽到 A 的影片）。
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
- **螢幕分享（D1）**：Bob 按「分享螢幕」：他看到「你正在分享畫面」條、自己維持格狀；Alice、Carol 的舞台切成分享版面、主區看到 Bob 的畫面（每秒 ≥ 3 幀）、Carol 的鏡頭在側列照常。Carol 按分享 → 「接手分享？」→ 接手：Bob 的提示條消失、大家看到 Carol 的畫面。Carol 從提示條停止：三人都回到格狀。headless Chromium 沒有螢幕可擷取、也沒有選擇器可點，所以分享來源是 `addInitScript` 換掉的 `getDisplayMedia`（canvas `captureStream`，會動的畫面）；真的選擇器在 §5 第 9 步實測。
- **分享音訊（D2）**：替身 `getDisplayMedia` 在房間要求音訊時多給一條 oscillator 的音軌（當成分頁音訊）。Alice、Carol 的 `audio[data-share-audio="Bob"]` 音量峰值 > 0.05（Bob 的麥克風此時是靜音的，聲音只會來自分享音訊）；Bob 按提示條的「關閉分享音訊」→ Alice 聽到靜音、分享畫面照常；「開啟分享音訊」→ 聲音回來。Carol 接手後 Bob 的分享音訊元素消失、Alice 聽得到 Carol 的分享音訊。真的分頁／系統音訊與回音在 §5 第 10 步實測。
- **聊天（D3）**：媒體檢查之前，Alice 打開聊天、送一則帶連結的中文訊息；Bob、Carol 的「聊天」鈕出現「1 則未讀」，打開後看到同一則訊息、連結是 `rel="noopener noreferrer"`，再關上（讓舞台回到全寬）。
- **等候室與鎖房（F2）**：Carol 被移出後，Alice（主持人）在參與者面板打開「等候室」；第四個 context Dave 加入：他看到等候畫面（「你是下一位」），Alice 看到「Dave 在等候室，等你放行」與琥珀色徽章，Bob 的舞台上沒有 Dave；Alice 按「放行」→ Dave 同一頁進房，Alice 與 Dave 互相收得到畫面與聲音、Dave 收得到 Bob 的畫面（Bob 前面靜音了）。Alice 打開「鎖定會議室」：三人都看到鎖頭；第五個 context 開連結直接是「這間會議室已鎖定」（沒有名字欄）。
- **離開後畫面（D4）**：最後 Carol 按「離開」：她看到「你已經離開會議室」與「重新加入」，按「5 分：很好」後出現「謝謝你的回饋！」，而且這個評分真的送到 `POST /api/events`（請求內容有 `{ "type": "rating", "score": 5 }`、回 202）；Alice、Bob 的舞台上 Carol 的格子消失。
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

   沒設定時 `/api/admin/summary` 回 503，`/admin` 顯示「還沒設定 ADMIN_TOKEN」；其他功能不受影響。
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
- **沒有 service worker**：有 manifest 與圖示，Chrome／Edge／Android 可以「安裝」或「加到主畫面」，iOS 用 `apple-touch-icon`；離線殼、安裝提示、新版本提示是 M1 的 `e4-t12`（AC-4.7）。
- **部署後檢查**：`scripts/smoke.sh` 在每次預覽與正式部署後確認這些檔案回 200 且型別正確（`image/svg+xml`、`image/png`、`application/manifest+json`），manifest 寫的是 LongTalk，首頁連到 manifest。
