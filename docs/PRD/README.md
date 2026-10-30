# PRD — 產品需求文件

LongTalk 的產品需求都在這個資料夾。三層結構（為什麼是三層見 [`../PLANNING-METHOD.md`](../PLANNING-METHOD.md)）：

```
00-prd.md（總 PRD：願景、範圍、F 功能需求、AC 總表、里程碑）
   └─ e1 … e11（每個 epic 一份：背景、目標、AC、task 拆分）
         └─ AC-<epic>.<n>（驗收條件，可勾選）
               └─ e<epic>-t<nn>（task：一個 task ≈ 一個 PR ≈ 1–3 天）
```

| 文件 | 內容 |
| --- | --- |
| [`00-prd.md`](00-prd.md) | 總 PRD：願景、背景、使用者、產品原則、功能地圖、F1–F38、非功能需求、AC 總表、M0–M3 里程碑、指標、風險 |
| [`01-competitive-analysis.md`](01-competitive-analysis.md) | 競品分析：Zoom 免費版功能盤點、Meet／Jitsi／Discord／Teams／Whereby 對照、我們能贏與不該打的地方 |
| `e1` … `e11` | 各 epic，見下表 |

## Epic 進度

統計日期 2026-10-30（A1–A4 完成）。勾選以各 epic 文件為準，改了勾選順手更新這張表。

| Epic | 名稱 | Task 完成 | AC 完成 | M0 task | M1 task | 狀態 |
| --- | --- | --- | --- | --- | --- | --- |
| [E1](e1-rooms-identity-host.md) | 房間、身分與主持人控制 | 3／19 | 0／8 | 5 | 12 | in progress |
| [E2](e2-media-core-webrtc-sfu.md) | 媒體核心：WebRTC 與 SFU | 2／18 | 0／8 | 10 | 7 | in progress |
| [E3](e3-screen-share.md) | 螢幕分享 | 0／11 | 0／6 | 5 | 5 | planned |
| [E4](e4-meeting-ui-experience.md) | 會議室介面與體驗 | 3／19 | 0／10 | 8 | 11 | in progress |
| [E5](e5-chat-reactions-interaction.md) | 聊天、反應與互動 | 0／9 | 0／5 | 2 | 4 | planned |
| [E6](e6-audio-video-quality.md) | 音訊視訊品質 | 0／8 | 0／6 | 0 | 5 | planned |
| [E7](e7-annotation-whiteboard.md) | 畫筆標註與白板 | 0／9 | 0／5 | 0 | 0 | planned（M2） |
| [E8](e8-recording-transcript-ai.md) | 錄影、逐字稿與 AI 摘要 | 0／9 | 0／6 | 0 | 3 | planned |
| [E9](e9-remote-control.md) | 遠端控制 | 0／9 | 0／5 | 0 | 0 | planned（M3） |
| [E10](e10-scale-breakout.md) | 規模：大房間與分組討論室 | 0／7 | 0／5 | 0 | 0 | planned（M2–M3） |
| [E11](e11-platform-security-cost-ops.md) | 平台、安全、成本與維運 | 2／12 | 0／10 | 4 | 4 | in progress |
| | **合計** | **10／130** | **0／74** | **34** | **51** | |

里程碑分布：M0 34 個、M1 51 個、M2 29 個、M3 16 個。M2／M3 的 task 刻意只寫一行，動工前那一批再細拆。

## Task 格式

```markdown
- [ ] `e2-t08` 斷線重連：WebSocket 與 PeerConnection 重建、媒體恢復 … · AC-2.5 · M · ← e2-t04
- [x] `e1-t01` Room 模型與短 id … · AC-1.1 · #3
```

| 欄位 | 說明 |
| --- | --- |
| 編號 | `e<epic>-t<nn>`，epic 內的流水號。**不重用、不改號**；作廢的 task 加刪除線並寫原因 |
| 做什麼 | 一句話，看得出 PR 的範圍與驗收方式 |
| 對應 AC | 這個 task 交付哪一條（或哪幾條）AC |
| 大小 | 未完成的 task：`S`（≤ 1 天）或 `M`（1–3 天）。**沒有 L**，超過 3 天就拆 |
| 依賴 | `← e2-t04`：要先合併的 task。只寫真正會卡住的依賴 |
| PR | 已完成的 task：合併的 PR 號（`#3`） |

規則：

1. **一組相關的 task 一個 PR**（一個 task 一個 PR 是最小單位；相鄰、同一條線的 task 可以合成一個）。分支名帶第一個 task 編號（例如 `feat/e2-t03-publish`），PR 標題結尾列出全部編號（例如 `feat(media): publish tracks to SFU [e2-t03, t04]`），PR 本文寫對應的 AC。
2. **在同一個 PR 勾選**：把自己的 task 從 `[ ]` 改成 `[x]`，大小與依賴換成 PR 號，並更新上面的進度表。
3. **AC 什麼時候勾**：這條 AC 的 task 全部完成，而且有人照 AC 文字實際驗證過（測試或實測寫在 PR）。媒體相關的 AC 一律要在**兩台不同裝置**實測。
4. **發現新工作就加 task**：接在該 epic 最後一個編號之後，放到正確的里程碑區段，不要塞進正在做的 PR。
5. 同一個 epic 內，M0 的 task 不依賴 M1 以後的 task。

里程碑：**M0** 能聊、**M1** 好用、**M2** 超越、**M3** 遠端控制與擴充（`00-prd.md` §11）。批次順序在 [`../ROADMAP.md`](../ROADMAP.md)。

## 怎麼新增一個 epic

1. 檔名 `e<n>-<英文-slug>.md`，frontmatter 照現有 epic（`title`、`date`、`status`、`epic`、`owner`、`milestones`、`depends_on`）。
2. 章節：背景、目標、非目標、需求、設計方向、驗收條件、Task 拆分、風險與對策、未決問題。
3. 在 `00-prd.md` 的功能地圖、F 表與 AC 總表登記；在這裡的進度表加一列；在 `ROADMAP.md` 加批次。
