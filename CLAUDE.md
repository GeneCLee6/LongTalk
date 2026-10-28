# CLAUDE.md — LongTalk · 長談

給 Claude Code 的專案說明。**目前只有規劃文件，沒有程式碼**（2026-10-28）。動工後 A1 批會補 `RULES.md`、`ARCHITECTURE.md` 改為現況、`DEPLOY.md`。

## 這是什麼

一間開著就不會斷的線上會議室：瀏覽器 WebRTC ＋ Cloudflare（Pages、Workers、Durable Objects、Realtime SFU、TURN、R2）。目標是取代 Zoom 免費版（40 分鐘限制），核心是音訊、視訊、螢幕分享；之後做標註、白板、雲端錄影、AI 摘要、遠端控制。技術與文件方法沿用淡江牌桌（`C:\dev\TKU-BridgeTable`），**不共用程式碼與帳號**。

## 先讀

| 情境 | 讀 |
| --- | --- |
| 任何 session 開頭 | 這份、`docs/NEXT.md`（現在的位置與工作方式） |
| 要做下一批 | `docs/ROADMAP.md` 的該批 → 該批 task 所在的 `docs/PRD/e*.md` 段落 |
| 產品範圍、為什麼做 | `docs/PRD/00-prd.md`（總 PRD）、`docs/PRD/01-competitive-analysis.md` |
| 技術架構與選型 | `docs/ARCHITECTURE.md`、`docs/adr-*.md`（A2 起） |
| 介面、顏色、元件 | `docs/DESIGN.md`、視覺稿 `docs/design/mockup.html` |
| 對外介紹 | `docs/design/pitch.html`、標誌 `docs/design/logo/` |
| 文件該怎麼分層 | `docs/PLANNING-METHOD.md` |

## 硬性規則

1. **權限與房間狀態只在伺服器（RoomDO）判斷**；前端只是按鈕。誰能靜音誰、誰能錄影、誰能標註，查 `worker/roles.ts`。
2. **媒體層只透過 `src/media/MediaTransport.ts` 介面**；不要在元件裡直接碰 `RTCPeerConnection` 或 SFU API。
3. **secrets 不進前端**：SFU App token、R2 憑證、AI 金鑰只在 Worker。
4. **錄影、逐字稿、遠端控制一律全員可見 ＋ 明確同意**，狀態寫在 RoomDO。
5. **顏色只來自 `styles/tokens.ts`，介面文字只來自 `strings.ts`**；只用於樣式的 prop 加 `$` 前綴。
6. **效能預算在 CI 擋**：首頁 JS gzip ≤ 150 kB、會議室頁 ≤ 350 kB；白板、模糊、錄影、標註 lazy。
7. **媒體相關的 AC 要在兩台不同裝置實測**才能勾。
8. **不要直接推送到 `main`，不要 force-push。** 功能走分支＋PR；合併用 `gh pr merge <號> --squash --delete-branch`。合併到 `main` 自動部署。
9. 程式碼、註解、commit、**PR 標題**用英文；文件與介面用繁體中文（台灣用語）。
10. 一批 = 一個 PR = 一個 session；照 `docs/ROADMAP.md` 批次號做，不跳批；在同一個 PR 更新 epic 勾選、進度表、ROADMAP、NEXT。

## 技術選型（規劃，A1／A2 定稿）

React 19 ＋ TypeScript strict ＋ Vite ＋ styled-components；Worker（Hono 或原生）＋ Durable Objects ＋ D1 ＋ R2；Cloudflare Realtime SFU ＋ TURN（後備 LiveKit）；Vitest、Playwright、oxlint。遠端控制的桌面端代理用 Tauri（M3）。
