# DEPLOY — 部署

LongTalk 是**一個 Cloudflare Worker**：同一個 Worker 回答 `/api/*`、承載 Durable Object（每房一個 `RoomDO`），其餘路徑交給靜態資產（React app，`dist/client`）。

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
| `preview.yml` | PR 開啟、更新 | 部署 `longtalk-pr-<號>`（`CLOUDFLARE_ENV=preview`），smoke test，把網址留言在 PR；PR 關閉時刪除該 Worker 與它的資料 |
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

- `wrangler.jsonc` 的 `migrations` **只能往後加**；已部署的 migration 不要改、不要刪。新增 DO class 就加一個新 tag。現有：`v1` `RoomDO`（A1）、`v2` `UsageDO`（B1，§6）；下一個是 `v3`。
- `vars` 也**不會繼承**：頂層與 `env.preview` 各寫一次（現有 `USAGE_LOW_QUALITY_GB`、`USAGE_AUDIO_ONLY_GB`，§6）。
- `env.preview` **不會繼承**頂層的綁定：每個 DO、KV、R2、D1 綁定都要在 `env.preview` 重寫一次；R2／D1 要給預覽自己的資源，不要指到正式站的。
- secret（SFU App token、TURN key、AI 金鑰）只用 `wrangler secret put` 放在 Worker，**不進前端、不進 repo**（CLAUDE.md 規則 3）。要設定的 secret 見 §5。

## 5. Secrets 與 Realtime 互通測試（A2，B1 起改用會議室頁）

### 要設定的 secret

| 名稱 | 放哪裡 | 從哪裡拿 | 誰用 |
| --- | --- | --- | --- |
| `REALTIME_APP_ID` | Worker secret | Cloudflare 儀表板 → Realtime → SFU → 建立 app → **App ID** | `worker/sfu.ts`（A2 起） |
| `REALTIME_APP_SECRET` | Worker secret | 同一個 app 的 **App Secret**（API token；只顯示一次） | `worker/sfu.ts`（A2 起） |
| `REALTIME_TURN_KEY_ID` | Worker secret | 儀表板 → Realtime → TURN → 建立 key → **Turn Token ID** | `e2-t07`（B 期，尚未使用） |
| `REALTIME_TURN_KEY_API_TOKEN` | Worker secret | 同一個 TURN key 的 **API token** | `e2-t07`（B 期，尚未使用） |

App ID 不算機密，但和 App Secret 放在一起管理比較不會漏。**沒設定時 `/api/sfu/<roomId>/*` 對房間成員回 503 `sfu_not_configured`**，其餘功能照常（進得了房、看得到成員，只是沒有聲音與畫面）。

**B1 起代理綁定房間成員**（`worker/sfu.ts`）：每個呼叫都要帶 RoomDO 在 `welcome` 發的 session token（`Authorization: Bearer …`），沒帶或不認得一律 401；SFU session 屬於建立它的成員，動別人的 session 403；只能 pull 同一間房發布的軌（不然 404 `track_not_in_room`）。所以正式站設定 secret 之後，不在房間裡的人用不到 SFU 流量。

```sh
# 正式站（secret 會保留到之後每次部署）
npx wrangler secret put REALTIME_APP_ID
npx wrangler secret put REALTIME_APP_SECRET

# 本機：寫進 .dev.vars（不進 git）
REALTIME_APP_ID=...
REALTIME_APP_SECRET=...
```

PR 預覽的 Worker 每個 PR 都是新的：在 GitHub 也設定同名的 `REALTIME_APP_ID`、`REALTIME_APP_SECRET`（`gh secret set …`），`preview.yml` 部署後會把它們寫進該 PR 的 Worker；沒設定就跳過（notice）。建議預覽與正式站用**不同的 Realtime app**，流量分開看。

### 兩台裝置互通測試（會議室頁）

A2 的 `/dev/realtime` spike 在 B1 移除（代理不再接受匿名呼叫）；改用會議室本身：

1. 一台裝置在 PR 預覽或正式站按「開一間房」，把連結傳給另一台（手機的鏡頭權限需要 HTTPS，所以用 PR 預覽或正式站；同一台電腦可以用 `npm run dev` 開兩個分頁先試）。
2. 兩邊各自在預先加入頁允許麥克風與鏡頭，按「加入」。
3. 通過的條件：兩邊的格子都看到並聽到對方。把兩台裝置、瀏覽器、網路（例如 Wi-Fi 與 4G）與結果寫進 PR。
4. 檢查代理沒有開放給房外：`curl -i -X POST https://…/api/sfu/<roomId>/sessions` 要回 401。

常見狀況：「媒體伺服器尚未設定」＝ secret 沒設；「媒體伺服器不認得這個分頁」＝ session token 過期（房間把成員移除了），重新整理；一直沒有對方的畫面 ＝ 網路擋 UDP，等 `e2-t07` 的 TURN。

## 6. Realtime 免費額度保護（e11-t13，B1）

擁有者決定**只用免費額度**（2026-10-31）：Realtime 的 SFU 與 TURN 共用每月 1,000 GB 流出。超過就要付費，所以 LongTalk 自己記帳、提早降級：

| 這個月（UTC）的流出 | 狀態 | 會發生什麼 |
| --- | --- | --- |
| 未滿 `USAGE_LOW_QUALITY_GB`（預設 800） | `normal` | 照常 |
| 達 `USAGE_LOW_QUALITY_GB` | `low` | 房裡每個人收到通知；鏡頭改成低畫質（320×180、15 fps）送出，新進房的人一開始就是低畫質 |
| 達 `USAGE_AUDIO_ONLY_GB`（預設 950） | `audioOnly` | 代理拒絕任何**新的**視訊軌（push 或 pull 都是 403 `usage_audio_only`）；已經在送的視訊不切斷；聲音照常；介面提示「只保留聲音」 |

- **怎麼算**：`UsageDO`（`worker/usage-do.ts`，整個部署一個，`idFromName('global')`）存這個月的累計。每間有人的房間在每 15 秒的 alarm 把這段時間的兩個數字交給它，**取大的那個**加進當月總數：(1) 瀏覽器每 10 秒經房間 WebSocket 回報的 `bytesReceived`（`stats` 訊息，RoomDO 只算增量、限速 25 Mbps 防灌水）；(2) 伺服器自己的估算：經過時間 × 每個連線中成員收的每條軌 × 假設位元率（cam 1.5 Mbps、screen 2.5 Mbps、mic 64 kbps，`shared/usage.ts`）。估算不信任瀏覽器，所以不回報也躲不掉；回報抓得到估算低估的情況。
- **每月 1 日歸零**：以 UTC 月份為準（台灣時間每月 1 日早上 8 點）。
- **門檻設定**：`wrangler.jsonc` 的 `vars`（頂層與 `env.preview` 各一份），單位 GB（十進位）。改了要重新部署；值不合法時用預設。
- **查詢**：`GET /api/usage` → `{"month":"2026-10","bytes":123456789,"state":"normal"}`（不快取）。
- **誤差**：這是估算，不是 Cloudflare 的帳單；TURN 流量（`e2-t07` 之後）也算在瀏覽器回報裡，但伺服器估算沒有另外加。真正的用量以 Cloudflare 儀表板為準，`e11-t09` 成本儀表板會拿這份計數和帳單對照。
- **重設或手動調整**：目前沒有管理介面；真的需要時把門檻 var 暫時調高或調低後重新部署。
