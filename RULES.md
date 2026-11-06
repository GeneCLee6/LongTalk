# RULES — 工程慣例

`CLAUDE.md` 是硬性規則的摘要；這份寫細節。

## 1. 分層與職責

| 位置 | 職責 | 禁止 |
| --- | --- | --- |
| `shared/` | 前後端共用的型別與純函式（通訊協定、id、版面計算） | React、DOM、Cloudflare API |
| `worker/app.ts` | HTTP 路由：`/api/*`，其餘交給靜態資產 | 房間狀態（屬於 RoomDO） |
| `worker/room.ts` | `RoomDO`：每房一個，房間狀態與權限的唯一真相 | 前端邏輯 |
| `worker/roles.ts`（F1） | 誰能做什麼：伺服器的判斷（`authorize`）；表本身在 `shared/roles.ts`，前端只拿來決定顯示哪些按鈕 | 在其他地方判斷權限 |
| `worker/accounts.ts`（I2） | `/api/account/*`：通行密鑰（`webauthn.ts`）、session（`session.ts`）、D1 的查詢（`account-db.ts`，表在 `migrations/`）、固定會議室、預定會議（I3；公開的 `GET /api/meetings/<id>` 在 `meetings.ts`） | 房間狀態（固定會議室的設定在 RoomDO，經 RPC）；寄信、密碼 |
| `worker/files.ts`（I5） | `/api/files/*`：上傳與下載，串流到 R2 綁定；誰能做什麼問 RoomDO（`room-files.ts`），全站上限問 `FileLedgerDO`（`file-ledger.ts`）；規則與數字在 `shared/files.ts`、`shared/file-limits.ts` | 把檔案讀進記憶體（只有開頭與縮圖）；房間狀態 |
| `worker/scheduled.ts`（I5） | Cron：`sweep.ts` 刪到期檔案、`backup.ts` D1 備份 | 帶任何 secret（只用綁定） |
| `worker/index.ts` | Worker 入口：匯出 handler（`fetch`、`scheduled`）與 DO class | 其他邏輯 |
| `src/media/` | `MediaTransport` 介面與實作（A2 起） | 元件直接碰 `RTCPeerConnection` 或 SFU API |
| `src/annotate/`（J1） | 標註畫布與繪製，全部 lazy（只有 `ShareTile` 的 `lazy()` 指向這裡）；模型與規則在 `shared/annotation.ts`，對齊問 `useShareGeometry()` | 被會議室的初始 JS 靜態匯入；自己換算分享畫面的位置 |
| `src/pages/` | 組合：取狀態、接路由 | 樣式細節以外的規則判斷 |
| `src/components/` | 展示與互動 | 直接呼叫 API 或 WebSocket（由 props 傳入 callback） |
| `src/styles/tokens.ts` | 顏色、字體、間距 | — |
| `src/pwa/`（G4） | service worker 的規則與 handler（`swRouting.ts`、`swWorker.ts`、`sw.ts`，`scripts/swPlugin.ts` 打包成 `/sw.js`），頁面端的註冊、新版本與安裝（`pwa.ts`、`update.ts`、`install.ts`） | app 匯入 `swRouting.ts`／`swWorker.ts`（只有 `sw.ts` 能匯入，型別除外）；service worker 碰 `/api/*` |
| `src/strings.ts` | 介面文字的唯一入口：目前語言的字典、`setLocale`、`Intl` 日期時間；字典本身在 `src/i18n/zh-TW.ts`、`en.ts` | 在模組層級存字典的一部分（`const text = strings.room` 會凍結成開頁時的語言） |

- **伺服器把關**：權限、房間狀態、錄影與同意，只在 RoomDO 判斷；前端只是按鈕。
- **DRY**：顏色只在 `styles/tokens.ts`；介面文字只在 `strings.ts`。`npm run lint` 會擋（G5，`scripts/literals.ts`）：`src/` 的程式碼（註解不算）裡有中文字或全形標點、顏色字面值（`#rgb`、`rgb()`、`hsl()`）、JSX 標籤之間的文字、`aria-label`／`title`／`placeholder`／`alt`／`label` 的字面文字就失敗；字典、`tokens.ts`、`brand.ts`、隱私權政策的文字（`src/privacy/policy.*`）除外，真的需要的那一行在行尾寫 `// literal-ok: <理由>`。
- **lazy**：會議室頁是獨立 chunk；白板、背景模糊、錄影、標註都要 `lazy()`，不能進首頁或會議室的初始 JS。
- **secrets 不進前端**（I1）：`src/`、`public/` 不能出現 Worker secret 的名字（`ADMIN_TOKEN`、`TURNSTILE_SECRET_KEY`…，連介面文字也不行）或像 secret 的值；`npm run lint` 掃原始碼、`npm run budget` 掃 `dist/client`（`scripts/secrets.ts`，`DEPLOY.md` §11）。真的需要的那一行在行尾寫 `// secret-ok: <理由>`。新的 secret 要加進 `scripts/secretScan.ts` 的 `SECRET_NAMES`。
- **安全標頭**（I1）：頁面的標頭改 `shared/security-headers.ts` 再同步 `public/_headers`（測試比對）；要從別的網域載入任何東西（script、iframe、fetch）都要先改 CSP，並在 `DEPLOY.md` §11 寫理由。

### 介面文字與語言（G1，`e4-t15`）

- 加一句介面文字：**兩本字典同一個 key 都要加**——先加 `src/i18n/zh-TW.ts`（`Strings` 型別從這本推導），再加 `src/i18n/en.ts`；英文少了 `npm run typecheck` 就失敗，`tests/app/g1.test.tsx` 也會比對兩本的 key、檢查英文裡沒有中文。
- 元件裡照舊 `import { strings } from '../strings.ts'`，**在用到的地方**讀 `strings.x.y`（render 或事件裡）；不要在模組層級把它存成常數或表格（要表格就寫成函式，例如 `memberActions()`）。
- 有變數的句子寫成函式（`(count: number) => …`），英文的單複數在函式裡處理；不要在元件裡拼字串。
- 日期時間用 `strings.ts` 的 `formatClock`、`formatDateTime`、`formatDay`（`Intl`），不要 `toLocaleString('zh-TW')` 寫死。
- 測試預設繁中（`tests/setupLocale.ts` 把 jsdom 的瀏覽器語言設成 zh-TW，`tests/setup.ts` 每個測試前 `setLocale('zh-TW', false)`）；要測英文就在測試裡 `setLocale('en', false)`。
- 靜態的 `index.html`、manifest、OG 圖只用中文字典（`src/brand.ts`）。

- **例外：隱私權政策的文字**（I6）不在兩本字典裡：它很長，放進字典就進了首頁的 JS（預算 150 kB）。每種語言一個 lazy 模組（`src/privacy/policy.zh-TW.ts`、`policy.en.ts`，型別 `src/privacy/types.ts`，缺一個語言或一個 key 是型別錯誤），字典裡只有連結的文字。數字一律從 `src/privacy/facts.ts` 讀常數，不要打在句子裡；**改了保留時間、儲存的東西、cookie、localStorage 的 key，要同時改這兩個模組與 `shared/privacy.ts` 的日期**，`tests/app/privacy.test.tsx`、`tests/worker/privacyFacts.test.ts` 會失敗提醒。

### 無障礙（G5，`e4-t14`）

- 圖示鈕的名稱用 `aria-label`，而且**看得到的字要出現在名稱裡**（WCAG 2.5.3：「放行」鈕叫「放行 Bob 進入會議室」，不是「讓 Bob 進來」）；徽章的數字用 CSS 畫（`data-count`），數字寫在名稱裡（「參與者（3 人）」）。
- 狀態不只靠顏色：靜音、說話、舉手、等候、錯誤都要有圖示或文字（toast 依語氣有不同圖示）。
- 會變的狀態要讓螢幕閱讀器知道，但不要吵：一直在頁面上的 live region（toast 的 `role="status"`、會議室的 `useAnnouncer`），**不要**用「出現時才掛上去的 `role="status"`」（常常念不出來）；說話中的變化不念。格子的名字就是名字，狀態（主持人、麥克風、鏡頭、舉手、釘選…）放在 `aria-describedby`。
- 每個操作都要能用鍵盤：自訂的按鈕、選單、抽屜用 `button`／`role="menu"`，Esc 關、焦點回原處；只在 hover 出現的按鈕在 `:focus-within` 時也要出現。焦點外框用全域的 `:focus-visible`（`color.focus`，2 px），不要 `outline: none`。
- 動畫在 `prefers-reduced-motion` 時要停（`GlobalStyle` 全域處理；JS 的動畫看 `useReducedMotion`）。
- 新的畫面或打開的狀態（對話框、抽屜）加進 `e2e/local/a11y.spec.ts`，axe 一個違規都不能有；顏色 token 的對比在 `tests/tokensContrast.test.ts`。

## 2. 程式風格

- TypeScript strict；不使用 `any`（oxlint 擋）；`erasableSyntaxOnly`（不用 enum、建構子參數屬性）。
- Prettier 設定見 `.prettierrc.json`（無分號、單引號、尾逗號、寬 100）。
- 只用於樣式的 prop 加 `$` 前綴（`$active`、`$size`），避免傳到 DOM。
- import 寫出 `.ts`／`.tsx` 副檔名。
- 程式碼、註解、commit、分支名稱、PR 標題用英文；文件與介面用繁體中文（台灣用語）。產品名稱只用英文 `LongTalk`。

## 3. 測試

- `tests/worker/`：Worker 與 RoomDO 的邏輯（Node 環境）。DO 的邏輯盡量寫成不依賴 `cloudflare:workers` 的純類別，讓 Vitest 直接測。
- `tests/app/`：元件與頁面，以 Testing Library 依角色與名稱查詢。
- `tests/` 下的 `.test.ts(x)` 都會被 Vitest 撿到；`tests/worker` 用 Worker 的 tsconfig（有 `@cloudflare/workers-types`）。
- `e2e/`：Playwright 對部署好的 Worker 跑（`BASE_URL`，`npm run test:e2e`），CI 在 PR 預覽上跑（`DEPLOY.md` §7）；檔名用 `.spec.ts`，Vitest 不會撿到。
- 瀏覽器能力只透過 `src/media/capabilities.ts` 偵測（不看 user agent）；加一個能力要同時在 `docs/BROWSER-SUPPORT.md` 加一列，測試會比對。唯一例外是權限教學挑哪一套**說明文字**（`src/room/permissionGuide.ts`），不決定功能開不開。
- 提交前：`npm run lint && npm run typecheck && npm test && npm run build && npm run budget`。

## 4. Commit、分支、PR

- Conventional Commits：`feat:`、`fix:`、`docs:`、`chore:`、`test:`、`refactor:`、`ci:`，可加範圍，如 `feat(media): publish tracks [e2-t03]`。
- 一批 = 一個分支 = 一個 PR（`docs/ROADMAP.md`）。分支名帶第一個 task 編號（`feat/e2-t03-publish`），PR 標題結尾列出全部編號。
- 不要直接推送 `main`，不要 force-push；合併用 `gh pr merge <號> --squash --delete-branch`。
- 在同一個 PR 勾選 epic task、AC（有驗證才勾）、`docs/PRD/README.md` 進度表、`docs/ROADMAP.md`、`docs/NEXT.md`。
