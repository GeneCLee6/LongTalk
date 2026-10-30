# LongTalk

**一間開著就不會斷的會議室。** 瀏覽器開會：音訊、視訊、螢幕分享、聊天，沒有 40 分鐘限制、不用裝 App、不用註冊。之後加畫筆標註、白板、雲端錄影、AI 摘要、遠端控制。

目前狀態：**A1 完成**（2026-10-30）：骨架、CI、部署 workflow。下一批 A2（媒體層 spike）與 A3（房間訊號）。

## 文件

| 文件 | 內容 |
| --- | --- |
| [`docs/PRD/00-prd.md`](docs/PRD/00-prd.md) | 總 PRD：願景、M0–M3、F1–F38、非功能需求、AC 總表、風險 |
| [`docs/PRD/01-competitive-analysis.md`](docs/PRD/01-competitive-analysis.md) | Zoom、Meet、Jitsi、Discord、Teams、Whereby 對照；我們能贏與不該打的地方 |
| [`docs/PRD/e1`…`e11`](docs/PRD/README.md) | 11 個 epic：背景、AC、task 拆分（130 個 task） |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | 批次順序 Phase A–O，一批一個 PR |
| [`docs/NEXT.md`](docs/NEXT.md) | 現在的位置、工作方式 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Cloudflare 全套架構、為什麼是 Realtime SFU、成本模型 |
| [`docs/DESIGN.md`](docs/DESIGN.md) | 設計規格：色票、字體、三個畫面、元件 |
| [`docs/design/mockup.html`](docs/design/mockup.html) | 視覺稿（首頁、預先加入、會議室、分享＋標註、手機；深淺色） |
| [`docs/design/pitch.html`](docs/design/pitch.html) | 專案介紹提案頁 |
| [`docs/design/logo/`](docs/design/logo/) | 標誌（SVG：完整、單圖、favicon、maskable） |
| [`docs/PLANNING-METHOD.md`](docs/PLANNING-METHOD.md) | 文件為什麼分三層、什麼時候才需要單獨的功能 PRD |
| [`CLAUDE.md`](CLAUDE.md) | 給 AI 協作者的規則 |

## 技術（規劃）

React 19 ＋ TypeScript ＋ Vite；Cloudflare Workers（帶靜態資產）、Durable Objects、D1、R2；Cloudflare Realtime SFU ＋ TURN（後備 LiveKit）；Tauri 桌面端代理（遠端控制，M3）。

## 開工

照 `docs/ROADMAP.md` 的批次號，從 A1 開始；開工指令在 ROADMAP 開頭。
