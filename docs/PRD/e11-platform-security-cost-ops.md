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
- 遙測：事件（進房成功／失敗原因、重連次數、TURN 比例、離開評分）送 Analytics Engine 或 D1；錯誤送 Sentry 類（自架或免費方案）；儀表板頁 `/admin`（擁有者）。
- 瀏覽器支援：`docs/BROWSER-SUPPORT.md` 每功能 × 瀏覽器矩陣；`src/lib/capabilities.ts` 統一能力偵測。
- 濫用防護：建房每 IP 每小時 10 間、Turnstile 於建房、WebSocket 訊息速率、上傳配額；黑名單 IP。
- 安全：CSP、HSTS、Permissions-Policy（camera、microphone、display-capture 只給自己）、COOP；依賴稽核；secrets 只在 Worker。
- 法遵：錄影同意、隱私權政策頁、資料保留表（聊天 24 小時、錄影 7–30 天、遙測 90 天）、個資法檢查清單、刪除請求流程。
- 清除與備份：R2 到期刪除排程（cron trigger）；D1 每日匯出到 R2（30 天）。
- 成本儀表板（M3）：Realtime、TURN、R2、Workers 用量 API 或估算；月預算；超額自動降級順序（關雲端錄影→限 HD→降最高層→限人數）；告警 Email。
- E2EE 研究（M2）：Insertable Streams／SFrame 可行性、對錄影與標註的影響；輸出 ADR。
- 多租戶（M3）：帳號配額、方案（免費／贊助）、擁有者後台。
- 測試：負載（E10 腳本）、混沌（殺 DO、斷 SFU、TURN 不可達）演練清單。

## 設計方向

- 複製淡江牌桌的 CI、效能預算腳本、`scripts/load/` 手法；不共用程式碼 repo。
- `/admin` 只給擁有者帳號；儀表板資料從 Analytics Engine SQL API 讀。

## 驗收條件

- [ ] AC-11.1 — Workers（帶靜態資產）＋DO 部署；preview 與 production；合併 `main` 自動上線；`DEPLOY.md`。
- [ ] AC-11.2 — CI：lint、typecheck、test、build、budget 全綠才可合併；M1 加視覺回歸與 Lighthouse。
- [ ] AC-11.3 — 進房成功率、失敗原因、重連、TURN 比例、評分可在 `/admin` 看；錯誤有告警。
- [ ] AC-11.4 — 成本儀表板：各項用量與預估費用、月預算、自動降級可演練、告警。
- [ ] AC-11.5 — 建房速率限制與 Turnstile、訊息速率、上傳配額、IP 黑名單；濫用測試。
- [ ] AC-11.6 — `BROWSER-SUPPORT.md` 完整且與 `capabilities.ts` 一致。
- [ ] AC-11.7 — CSP、HSTS、Permissions-Policy、COOP；`npm audit` 無高風險；secrets 不進前端（lint 擋）。
- [ ] AC-11.8 — 隱私權政策頁、資料保留表、錄影同意清單、刪除請求流程；R2 到期刪除與 D1 備份有排程測試。
- [ ] AC-11.9 — E2EE 可行性 ADR。
- [ ] AC-11.10 — 多租戶：帳號配額、方案、擁有者後台。

## Task 拆分

### M0

- [x] `e11-t01` repo 骨架：Vite／React／TS、`worker/`、`shared/`、wrangler、Vitest、oxlint、`CLAUDE.md`／`RULES.md` · AC-11.1 · #PR_A1
- [x] `e11-t02` CI（lint、typecheck、test、build、budget）、PR 預覽 Worker 與 production 部署、`DEPLOY.md` · AC-11.1, AC-11.2 · #PR_A1
- [ ] `e11-t03` 最小遙測：事件 API、Analytics Engine、錯誤回報、`/admin` 骨架 · AC-11.3 · M · ← e11-t02
- [ ] `e11-t04` `BROWSER-SUPPORT.md` 初版與 `capabilities.ts` · AC-11.6 · S · ← e11-t01

### M1

- [ ] `e11-t05` 濫用防護：建房速率、Turnstile、訊息速率、IP 黑名單 · AC-11.5 · M · ← e1-t02
- [ ] `e11-t06` 安全標頭、CSP、Permissions-Policy、secrets lint、依賴稽核進 CI · AC-11.7 · S · ← e11-t02
- [ ] `e11-t07` 法遵：隱私權政策頁、資料保留表、錄影同意清單、刪除請求 · AC-11.8 · S · ← e8-t02
- [ ] `e11-t08` R2 到期刪除 cron、D1 每日備份到 R2、還原演練 · AC-11.8 · S · ← e11-t02

### M2

- [ ] `e11-t09` 成本儀表板：用量 API／估算、月預算、自動降級、告警 · AC-11.4 · M · ← e11-t03

### M3

- [ ] `e11-t10` E2EE 可行性研究 ADR · AC-11.9 · S
- [ ] `e11-t11` 多租戶：配額、方案、擁有者後台（與 E1 `e1-t19`） · AC-11.10 · M · ← e1-t12
- [ ] `e11-t12` 混沌演練清單與執行（殺 DO、斷 SFU、TURN 不可達） · AC-11.3 · S · ← e10-t03

## 風險與對策

| 風險 | 對策 |
| --- | --- |
| 免費額度政策變動 | 儀表板早於擴張；降級順序先寫好 |
| 被拿去當匿名騷擾工具 | 速率限制、Turnstile、檢舉連結、IP 黑名單 |

## 未決問題

- [ ] **Q:** 錯誤回報用 Sentry 免費方案還是自架？
      **A:** _(e11-t03 前決定)_
