# RULES — 工程慣例

`CLAUDE.md` 是硬性規則的摘要；這份寫細節。

## 1. 分層與職責

| 位置 | 職責 | 禁止 |
| --- | --- | --- |
| `shared/` | 前後端共用的型別與純函式（通訊協定、id、版面計算） | React、DOM、Cloudflare API |
| `worker/app.ts` | HTTP 路由：`/api/*`，其餘交給靜態資產 | 房間狀態（屬於 RoomDO） |
| `worker/room.ts` | `RoomDO`：每房一個，房間狀態與權限的唯一真相 | 前端邏輯 |
| `worker/roles.ts`（F1） | 誰能做什麼：伺服器的判斷（`authorize`）；表本身在 `shared/roles.ts`，前端只拿來決定顯示哪些按鈕 | 在其他地方判斷權限 |
| `worker/index.ts` | Worker 入口：匯出 handler 與 DO class | 其他邏輯 |
| `src/media/` | `MediaTransport` 介面與實作（A2 起） | 元件直接碰 `RTCPeerConnection` 或 SFU API |
| `src/pages/` | 組合：取狀態、接路由 | 樣式細節以外的規則判斷 |
| `src/components/` | 展示與互動 | 直接呼叫 API 或 WebSocket（由 props 傳入 callback） |
| `src/styles/tokens.ts` | 顏色、字體、間距 | — |
| `src/pwa/`（G4） | service worker 的規則與 handler（`swRouting.ts`、`swWorker.ts`、`sw.ts`，`scripts/swPlugin.ts` 打包成 `/sw.js`），頁面端的註冊、新版本與安裝（`pwa.ts`、`update.ts`、`install.ts`） | app 匯入 `swRouting.ts`／`swWorker.ts`（只有 `sw.ts` 能匯入，型別除外）；service worker 碰 `/api/*` |
| `src/strings.ts` | 介面文字的唯一入口：目前語言的字典、`setLocale`、`Intl` 日期時間；字典本身在 `src/i18n/zh-TW.ts`、`en.ts` | 在模組層級存字典的一部分（`const text = strings.room` 會凍結成開頁時的語言） |

- **伺服器把關**：權限、房間狀態、錄影與同意，只在 RoomDO 判斷；前端只是按鈕。
- **DRY**：顏色只在 `styles/tokens.ts`；介面文字只在 `strings.ts`。
- **lazy**：會議室頁是獨立 chunk；白板、背景模糊、錄影、標註都要 `lazy()`，不能進首頁或會議室的初始 JS。

### 介面文字與語言（G1，`e4-t15`）

- 加一句介面文字：**兩本字典同一個 key 都要加**——先加 `src/i18n/zh-TW.ts`（`Strings` 型別從這本推導），再加 `src/i18n/en.ts`；英文少了 `npm run typecheck` 就失敗，`tests/app/g1.test.tsx` 也會比對兩本的 key、檢查英文裡沒有中文。
- 元件裡照舊 `import { strings } from '../strings.ts'`，**在用到的地方**讀 `strings.x.y`（render 或事件裡）；不要在模組層級把它存成常數或表格（要表格就寫成函式，例如 `memberActions()`）。
- 有變數的句子寫成函式（`(count: number) => …`），英文的單複數在函式裡處理；不要在元件裡拼字串。
- 日期時間用 `strings.ts` 的 `formatClock`、`formatDateTime`、`formatDay`（`Intl`），不要 `toLocaleString('zh-TW')` 寫死。
- 測試預設繁中（`tests/setupLocale.ts` 把 jsdom 的瀏覽器語言設成 zh-TW，`tests/setup.ts` 每個測試前 `setLocale('zh-TW', false)`）；要測英文就在測試裡 `setLocale('en', false)`。
- 靜態的 `index.html`、manifest、OG 圖只用中文字典（`src/brand.ts`）。

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
