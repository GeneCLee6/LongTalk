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

- `wrangler.jsonc` 的 `migrations` **只能往後加**；已部署的 migration 不要改、不要刪。新增 DO class 就加一個新 tag（`v2`…）。
- `env.preview` **不會繼承**頂層的綁定：每個 DO、KV、R2、D1 綁定都要在 `env.preview` 重寫一次；R2／D1 要給預覽自己的資源，不要指到正式站的。
- secret（SFU App token、TURN key、AI 金鑰）只用 `wrangler secret put` 放在 Worker，**不進前端、不進 repo**（CLAUDE.md 規則 3）。A2 起會在這裡列出要設定的 secret。
