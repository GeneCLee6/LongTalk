# BROWSER-SUPPORT — 瀏覽器支援

最後更新 2026-11-02（B4 初版，`e11-t04`）。完整版（Playwright 多瀏覽器、iOS／Android 實機清單）是 H6 的 `e2-t16`（AC-2.8）。

目標瀏覽器（`PRD/00-prd.md` §9）：Chrome／Edge 最近兩版、Firefox 最近兩版、Safari 17+（macOS）、iOS Safari 17+、Android Chrome。

## 1. 原則

- **只做能力偵測，不看 user agent。** 程式在 [`src/media/capabilities.ts`](../src/media/capabilities.ts)：要用一個功能之前先問它，沒有就隱藏或說明，不讓按鈕按了才壞。
- **這份與 `capabilities.ts` 一致。** §2 表格的第二欄就是 `Capabilities` 的 key；`tests/app/media/capabilities.test.ts` 會比對兩邊，加一個能力要同時加一列。
- **偵測只說 API 在不在，不保證好用。** 各瀏覽器實際表現以實測為準；沒測過的就寫「未實測」，不寫成支援。
- 麥克風、鏡頭、螢幕分享都只在 HTTPS（或 `localhost`）可用；http 頁面上 `navigator.mediaDevices` 不存在，會被當成「不能用裝置」處理。

## 2. 功能矩陣

圖例：**●** 支援，且在這個瀏覽器實測過；**○** 依 MDN／瀏覽器文件應支援，**未實測**；**✕** 不支援；**?** 不確定，**未實測**。

| 功能 | `capabilities.ts` | Chrome | Edge | Firefox | Safari（macOS） | iOS Safari | Android Chrome | 沒有時 LongTalk 怎麼做 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| WebRTC 通話（`RTCPeerConnection`） | `webrtc` | ● | ○ | ○ | ○ | ○ | ● | 進房前就顯示「這個瀏覽器不能視訊通話，請改用…」（`e2-t09`） |
| 麥克風、鏡頭（`getUserMedia`） | `getUserMedia` | ● | ○ | ○ | ○ | ○ | ● | 仍可加入，看得到、聽得到別人；提示「網頁需要 HTTPS」 |
| 螢幕分享（`getDisplayMedia`） | `getDisplayMedia` | ○ | ○ | ○ | ○ | ✕ | ✕ | 尚未實作（D1）；之後沒有就隱藏「分享螢幕」 |
| 選擇喇叭（`setSinkId`） | `setSinkId` | ● | ○ | ○（116+） | ? | ✕ | ? | 不顯示喇叭選單，用系統預設輸出 |
| 不重新協商換軌（`RTCRtpSender.replaceTrack`） | `replaceTrack` | ● | ○ | ○ | ○ | ○ | ? | 靜音、關鏡頭、換裝置都靠它；目前所有目標瀏覽器都有，未另做退路 |
| 發送參數（`RTCRtpSender.setParameters`，simulcast 與位元率上限） | `senderParameters` | ○ | ○ | ○ | ○ | ○ | ○ | 尚未使用；simulcast 是 M1 的 `e2-t11`（Safari 預計退化為單層） |
| 音量表（`AudioContext`） | `audioContext` | ● | ○ | ○ | ○ | ○ | ? | 預先加入頁的音量表保持空白，其他照常 |
| 裝置插拔通知（`devicechange`） | `deviceChange` | ● | ○ | ○ | ○ | ? | ? | 拔掉的裝置要等軌結束才發現；接上新裝置不會自動補回 |

### 實測紀錄

| 日期 | 瀏覽器 | 方式 | 結果 |
| --- | --- | --- | --- |
| 每個 PR | Chromium（Playwright，Linux，headless） | CI `Preview / e2e`：兩個假裝置瀏覽器在 PR 預覽互通（`e2e/interop.spec.ts`） | 互看畫面有幀、聲音音量 > 0、靜音與關鏡頭對方看得到 |
| 2026-11-02 | 電腦 Chrome（Windows，無鏡頭）＋ Android Chrome | 兩台裝置、PR #8 預覽 | 電腦看到並聽到手機；電腦 → 手機的視訊未測 |
| 2026-11-02 | Chrome（Windows，headless，假裝置） | PR #9、#10 預覽的一次性腳本 | 開關、換裝置、斷線重連都正常（細節在 PR） |

Edge、Firefox、Safari（macOS）、iOS Safari 都還沒有實測。

## 3. 已知的瀏覽器差異（未實測，依文件）

- **iOS Safari**：不能分享螢幕；分頁進背景時鏡頭會停；聲音要在使用者點擊後才能播放（預先加入頁的「加入」按鈕算一次點擊）；不能選喇叭。手機版面先做「聽與看」（C3）。
- **Android Chrome**：不能分享螢幕；選喇叭的支援度不確定，app 以偵測結果為準。
- **Firefox**：116 版起才有 `setSinkId`；分享螢幕時的系統音訊不穩（E3 處理）。
- **Safari（macOS）**：分享螢幕沒有音訊；simulcast 與編碼差異預計在 `e2-t16` 實測。

## 4. 怎麼更新這份

1. 新功能要用到瀏覽器 API：先在 `capabilities.ts` 加一個 key 與偵測函式，在 §2 加一列（第二欄寫 key），`npm test` 會檢查兩邊一致。
2. 在某個瀏覽器實測過：把對應格子改成 ●，在「實測紀錄」加一列（日期、裝置、PR、結果）。
3. 發現不支援或有問題：改成 ✕ 或寫進 §3，並讓 app 依偵測結果隱藏或說明。
