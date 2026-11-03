# BROWSER-SUPPORT — 瀏覽器支援

最後更新 2026-11-02（B4 初版，`e11-t04`；C2 加剪貼簿與系統分享選單；D2 加分享音訊、不能分享時的說明）。完整版（Playwright 多瀏覽器、iOS／Android 實機清單）是 H6 的 `e2-t16`（AC-2.8）。

目標瀏覽器（`PRD/00-prd.md` §9）：Chrome／Edge 最近兩版、Firefox 最近兩版、Safari 17+（macOS）、iOS Safari 17+、Android Chrome。

## 1. 原則

- **只做能力偵測，不看 user agent。** 程式在 [`src/media/capabilities.ts`](../src/media/capabilities.ts)：要用一個功能之前先問它，沒有就隱藏或說明，不讓按鈕按了才壞。唯一的例外是**說明文字**：權限教學（G1，`src/room/permissionGuide.ts`）看 user agent 猜你用哪個瀏覽器、先顯示那一套步驟（猜錯可以自己換），從不拿它決定功能開不開。
- **這份與 `capabilities.ts` 一致。** §2 表格的第二欄就是 `Capabilities` 的 key；`tests/app/media/capabilities.test.ts` 會比對兩邊，加一個能力要同時加一列。
- **偵測只說 API 在不在，不保證好用。** 各瀏覽器實際表現以實測為準；沒測過的就寫「未實測」，不寫成支援。
- 麥克風、鏡頭、螢幕分享都只在 HTTPS（或 `localhost`）可用；http 頁面上 `navigator.mediaDevices` 不存在，會被當成「不能用裝置」處理。

## 2. 功能矩陣

圖例：**●** 支援，且在這個瀏覽器實測過；**○** 依 MDN／瀏覽器文件應支援，**未實測**；**✕** 不支援；**?** 不確定，**未實測**。

| 功能 | `capabilities.ts` | Chrome | Edge | Firefox | Safari（macOS） | iOS Safari | Android Chrome | 沒有時 LongTalk 怎麼做 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| WebRTC 通話（`RTCPeerConnection`） | `webrtc` | ● | ○ | ○ | ○ | ○ | ● | 進房前就顯示「這個瀏覽器不能視訊通話，請改用…」（`e2-t09`） |
| 麥克風、鏡頭（`getUserMedia`） | `getUserMedia` | ● | ○ | ○ | ○ | ○ | ● | 仍可加入，看得到、聽得到別人；提示「網頁需要 HTTPS」 |
| 螢幕分享（`getDisplayMedia`） | `getDisplayMedia` | ○ | ○ | ○ | ○ | ✕ | ✕ | 工具列不顯示「分享螢幕」，「更多」第一項是灰色的「分享螢幕」並說明原因：手機寫「手機瀏覽器不能分享螢幕，要分享請用電腦加入」，電腦寫「請改用電腦上的 Chrome、Edge 或 Firefox」（`e3-t10`） |
| 分享音訊（分頁或系統音訊；偵測 `getSupportedConstraints().suppressLocalAudioPlayback`） | `shareAudio` | ○ | ○ | ✕ | ✕ | ✕ | ✕ | 選擇器不要求音訊，只分享畫面；「你正在分享畫面」條沒有音訊開關（`e3-t04`）。Chrome／Edge：分享分頁可帶分頁音訊，分享整個螢幕在 Windows、ChromeOS 可帶系統音訊（macOS 依 Chrome 與系統版本而定）；分享視窗通常沒有音訊。以上依文件，都還沒實測 |
| 選擇喇叭（`setSinkId`） | `setSinkId` | ● | ○ | ○（116+） | ? | ✕ | ? | 不顯示喇叭選單，用系統預設輸出 |
| 不重新協商換軌（`RTCRtpSender.replaceTrack`） | `replaceTrack` | ● | ○ | ○ | ○ | ○ | ? | 靜音、關鏡頭、換裝置都靠它；目前所有目標瀏覽器都有，未另做退路 |
| 發送參數（`RTCRtpSender.setParameters`，simulcast 與位元率上限） | `senderParameters` | ○ | ○ | ○ | ○ | ○ | ○ | 尚未使用；simulcast 是 M1 的 `e2-t11`（Safari 預計退化為單層） |
| 音量表（`AudioContext`） | `audioContext` | ● | ○ | ○ | ○ | ○ | ? | 預先加入頁的音量表保持空白，其他照常 |
| 裝置插拔通知（`devicechange`） | `deviceChange` | ● | ○ | ○ | ○ | ? | ? | 拔掉的裝置要等軌結束才發現；接上新裝置不會自動補回 |
| 複製到剪貼簿（`navigator.clipboard.writeText`） | `clipboard` | ○ | ○ | ○ | ○ | ○ | ○ | 頂部條「複製連結」改用分享選單（有的話），否則提示「請手動複製」並顯示連結（`e1-t05`） |
| 系統分享選單（Web Share，`navigator.share`） | `webShare` | ○ | ○ | ✕ | ○ | ○ | ○ | 「更多」選單不顯示「分享連結」，用「複製連結」（`e1-t05`） |
| 讀取權限狀態（`navigator.permissions.query` 的 `camera`、`microphone`） | `permissions` | ○ | ○ | ○（131+ 才認得這兩個名字） | ○（16+） | ○（16+） | ○ | 預先加入頁的權限教學照樣顯示，但分不出「系統擋住」與「瀏覽器擋住」，允許之後要自己按「再試一次」（G1，`e4-t09`） |

### 實測紀錄

| 日期 | 瀏覽器 | 方式 | 結果 |
| --- | --- | --- | --- |
| 每個 PR | Chromium（Playwright，Linux，headless） | CI `Preview / e2e`：三個假裝置瀏覽器在 PR 預覽互通（`e2e/interop.spec.ts`） | 互看畫面有幀、聲音音量 > 0、靜音與關鏡頭對方看得到 |
| 2026-11-02 | 電腦 Chrome（Windows，無鏡頭）＋ Android Chrome | 兩台裝置、PR #8 預覽 | 電腦看到並聽到手機；電腦 → 手機的視訊未測 |
| 2026-11-02 | Chrome（Windows，headless，假裝置） | PR #9、#10 預覽的一次性腳本 | 開關、換裝置、斷線重連都正常（細節在 PR） |

Edge、Firefox、Safari（macOS）、iOS Safari 都還沒有實測。

## 3. 已知的瀏覽器差異（未實測，依文件）

- **iOS Safari**：不能分享螢幕；分頁進背景時鏡頭會停；聲音要在使用者點擊後才能播放（預先加入頁的「加入」按鈕算一次點擊）；不能選喇叭。手機版面先做「聽與看」（C3）。
- **Android Chrome**：不能分享螢幕；選喇叭的支援度不確定，app 以偵測結果為準。
- **Firefox**：116 版起才有 `setSinkId`；分享螢幕不能帶分頁或系統音訊（`shareAudio` 偵測為否，選擇器不要求音訊）。
- **Safari（macOS）**：分享螢幕沒有音訊；simulcast 與編碼差異預計在 `e2-t16` 實測。
- **分享音訊（Chrome／Edge，D2）**：分頁音訊要在選擇器勾「同時分享分頁音訊」（預設勾）；整個螢幕的系統音訊只在 Windows、ChromeOS（macOS 依版本）；分享視窗通常沒有音訊。LongTalk 要求 `restrictOwnAudio`（系統音訊裡不含這個會議分頁自己播的聲音，避免大家聽到自己的回音）與 `suppressLocalAudioPlayback: false`（分享者自己仍聽得到分頁）；不支援的瀏覽器會忽略這兩個選項。以上依文件，要在 `DEPLOY.md` §5 第 10 步實測。

## 4. 怎麼更新這份

1. 新功能要用到瀏覽器 API：先在 `capabilities.ts` 加一個 key 與偵測函式，在 §2 加一列（第二欄寫 key），`npm test` 會檢查兩邊一致。
2. 在某個瀏覽器實測過：把對應格子改成 ●，在「實測紀錄」加一列（日期、裝置、PR、結果）。
3. 發現不支援或有問題：改成 ✕ 或寫進 §3，並讓 app 依偵測結果隱藏或說明。
