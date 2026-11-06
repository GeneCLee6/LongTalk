# BROWSER-SUPPORT — 瀏覽器支援

最後更新 2026-11-06（J1 加了 `fullscreen`；2026-11-04 I4 加了 `localRecording`；2026-11-03 H6 完整版，`e2-t16`；B4 初版 `e11-t04`，之後 C2、D2、G4、H4、H5 各加了幾列）。這份是相容矩陣（AC-2.8、AC-11.6）：每個 `capabilities.ts` 偵測的能力 × 六個目標瀏覽器、沒有時怎麼做、哪些在 CI 跑過、哪些等實機。實機的測法在 [`DEPLOY.md`](../DEPLOY.md) §5「實機測試計畫」。

目標瀏覽器（`PRD/00-prd.md` §9）：Chrome／Edge 最近兩版、Firefox 最近兩版、Safari 17+（macOS）、iOS Safari 17+、Android Chrome。

## 1. 原則

- **只做能力偵測，不看 user agent。** 程式在 [`src/media/capabilities.ts`](../src/media/capabilities.ts)：要用一個功能之前先問它，沒有就隱藏或說明，不讓按鈕按了才壞。唯一的例外是**說明文字**：權限教學（G1，`src/room/permissionGuide.ts`）看 user agent 猜你用哪個瀏覽器、先顯示那一套步驟（猜錯可以自己換），從不拿它決定功能開不開。
- **這份與 `capabilities.ts` 一致，兩道檢查。** (1) §2 表格的第二欄就是 `Capabilities` 的 key，`tests/app/media/capabilities.test.ts` 比對兩邊的列與順序、每格都有記號（`npm test`）。(2) `e2e/local/browsers.spec.ts`（CI `UI checks / browsers`）在 Chromium、Firefox、WebKit 裡跑 app 自己的偵測程式，和這張表的 Chrome、Firefox、Safari（macOS）三欄比：寫 ✕ 的偵測必須是否、寫 ● 或 ○ 的必須是是；不一致就失敗。只有 Playwright 的引擎和品牌瀏覽器已知不同的格子不比（寫在那個測試的 `ENGINE_DIFFERENCES`，每次的偵測結果在 run 的 Summary）。
- **偵測只說 API 在不在，不保證好用。** 實際表現以實測為準；沒測過的寫 ○，不寫成 ●。
- 麥克風、鏡頭、螢幕分享都只在 HTTPS（或 `localhost`）可用；http 頁面上 `navigator.mediaDevices` 不存在，會被當成「不能用裝置」處理。

## 2. 功能矩陣

圖例：

- **●** 支援，而且**在真的瀏覽器或裝置上**實測過（§4 實測紀錄有一列）。
- **● CI** 支援，**CI 的 Playwright 瀏覽器**實際跑過這個功能（Linux、headless；Chrome 欄是 Chromium，Firefox 欄是 Playwright 的 Firefox，Safari 欄是 Playwright 的 WebKit，也就是 Safari 的引擎、但不是 Safari 本身）。品牌瀏覽器與真的裝置仍要實機測。
- **○** 依 MDN／瀏覽器文件應支援，CI 跑過的那三欄偵測也說有，但**這個功能還沒實際跑過**。
- **✕** 不支援；最後一欄是 LongTalk 的退路。
- **?** 不確定，未實測；app 照偵測結果做。

| 功能 | `capabilities.ts` | Chrome | Edge | Firefox | Safari（macOS） | iOS Safari | Android Chrome | 沒有時 LongTalk 怎麼做 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| WebRTC 通話（`RTCPeerConnection`） | `webrtc` | ● | ○ | ● CI | ● CI | ○ | ● | 進房前就顯示「這個瀏覽器不能視訊通話，請改用…」（`e2-t09`；Windows 版的 Playwright WebKit 沒有 WebRTC，本機跑 `browsers.spec.ts` 時檢查的就是這個畫面） |
| 麥克風、鏡頭（`getUserMedia`） | `getUserMedia` | ● | ○ | ● CI | ● CI | ○ | ● | 仍可加入，看得到、聽得到別人；提示「網頁需要 HTTPS」。拒絕權限與沒有裝置時的預先加入頁，三個引擎都在 CI 跑過（替身） |
| 螢幕分享（`getDisplayMedia`） | `getDisplayMedia` | ○ | ○ | ○ | ○ | ✕ | ✕ | 工具列不顯示「分享螢幕」，「更多」第一項是灰色的「分享螢幕」並說明原因：手機寫「手機瀏覽器不能分享螢幕，要分享請用電腦加入」，電腦寫「請改用電腦上的 Chrome、Edge 或 Firefox」（`e3-t10`）。CI 三個引擎都偵測到、也經 SFU 送出分享，但畫面來源是替身（headless 沒有選擇器），所以仍是 ○ |
| 分享音訊（分頁或系統音訊；偵測 `getSupportedConstraints().suppressLocalAudioPlayback`） | `shareAudio` | ○ | ○ | ✕ | ✕ | ✕ | ✕ | 選擇器不要求音訊，只分享畫面；「你正在分享畫面」條沒有音訊開關（`e3-t04`）。Chrome／Edge：分享分頁可帶分頁音訊，分享整個螢幕在 Windows、ChromeOS 可帶系統音訊（macOS 依 Chrome 與系統版本而定）；分享視窗通常沒有音訊 |
| 選擇喇叭（`setSinkId`） | `setSinkId` | ● | ○ | ○（116+） | ? | ✕ | ? | 不顯示喇叭選單與「測試喇叭」，用系統預設輸出。Playwright 的 WebKit 偵測為否；Safari 本身要實機確認 |
| 不重新協商換軌（`RTCRtpSender.replaceTrack`） | `replaceTrack` | ● | ○ | ● CI | ● CI | ○ | ? | 靜音、關鏡頭、換裝置都靠它；目前所有目標瀏覽器都有，未另做退路。CI：Firefox、WebKit 靜音後對方看到紅色麥克風、聽到靜音，再打開又聽得到 |
| 發送參數（`RTCRtpSender.setParameters`，simulcast 與位元率上限） | `senderParameters` | ● CI | ○ | ● CI | ○ | ○ | ○ | simulcast（`e2-t11`）：瀏覽器拒絕三層時 `addTransceiver` 退回單層，別人照樣看得到，只是不能選層。CI：Chromium、Firefox 都送出 `f`／`h`／`q` 三層（1280×720、640×360、320×180）；WebKit 協商了三層、但量的當下只有 `f` 有畫面（§3） |
| 音量表（`AudioContext`） | `audioContext` | ● | ○ | ○ | ○ | ○ | ? | 預先加入頁的音量表保持空白，其他照常 |
| 麥克風處理開關（`getSupportedConstraints()` 的 `noiseSuppression`、`echoCancellation`、`autoGainControl`） | `audioProcessing` | ○ | ○ | ○ | ○ | ○ | ○ | 設定面板只顯示瀏覽器認得的開關，一個都不認得時「音訊」頁只有裝置選單。能不能在通話中即時改要看瀏覽器：改不了就重新開麥克風、換送出的軌（不重新協商，`e6-t01`）。三個引擎都偵測到，效果要實機聽 |
| 進階噪音抑制（`AudioContext.audioWorklet`、`AudioWorkletNode`、`createMediaStreamDestination`、`WebAssembly`；不需要 `SharedArrayBuffer`） | `advancedNoiseSuppression` | ● CI | ○ | ○ | ○ | ○ | ○ | 設定的「音訊」頁不顯示「進階噪音抑制」，只用瀏覽器自己的噪音抑制（`e6-t02`）。RNNoise 要 48 kHz：Firefox 的麥克風不是 48 kHz 時接不上，會提示「無法開啟進階噪音抑制」並關掉；有 SIMD 的瀏覽器載入較快的那一版 wasm。CI：headless Chromium 實際載入並執行（`e2e/local/noise.spec.ts`；worklet 裡沒有 `performance.now()`，用 `Date.now()` 量負載） |
| 裝置插拔通知（`devicechange`） | `deviceChange` | ● | ○ | ○ | ○ | ? | ? | 拔掉的裝置要等軌結束才發現；接上新裝置不會自動補回 |
| 複製到剪貼簿（`navigator.clipboard.writeText`） | `clipboard` | ○ | ○ | ○ | ○ | ○ | ○ | 頂部條「複製連結」改用分享選單（有的話），否則提示「請手動複製」並顯示連結（`e1-t05`） |
| 系統分享選單（Web Share，`navigator.share`） | `webShare` | ○ | ○ | ✕ | ○ | ○ | ○ | 「更多」選單不顯示「分享連結」，用「複製連結」（`e1-t05`）。Chrome 只有 Windows、macOS、ChromeOS 有（Linux 沒有）；Playwright 的 Chromium、WebKit 都沒有，CI 不比這一列 |
| 讀取權限狀態（`navigator.permissions.query` 的 `camera`、`microphone`） | `permissions` | ○ | ○ | ○（131+ 才認得這兩個名字） | ○（16+） | ○（16+） | ○ | 預先加入頁的權限教學照樣顯示，但分不出「系統擋住」與「瀏覽器擋住」，允許之後要自己按「再試一次」（G1，`e4-t09`） |
| App 殼離線與新版本提示（Service Worker，`navigator.serviceWorker`） | `serviceWorker` | ● | ○ | ○（私密視窗沒有） | ○ | ○ | ○ | 沒有離線殼（離線時打不開），新版本改由比對 `/api/health` 的版本提示（G4，`e4-t12`） |
| 瀏覽器的安裝對話框（`beforeinstallprompt`） | `installPrompt` | ○ | ○ | ✕ | ✕ | ✕ | ○ | 首頁不顯示「安裝 LongTalk」；iOS／iPadOS Safari 改顯示「分享 › 加入主畫面」的一次性提示，其他瀏覽器什麼都不顯示（G4） |
| 從分享選單加入主畫面（`navigator.standalone`，只有 iOS／iPadOS Safari） | `homeScreenHint` | ✕ | ✕ | ✕ | ✕ | ○ | ✕ | 不是 iOS Safari 就不顯示這個提示（G4） |
| 電量（Battery Status API，`navigator.getBattery`） | `battery` | ○ | ○ | ✕ | ✕ | ✕ | ○ | 不提示「電量不多了，可以開省電模式」；省電模式本身在每個瀏覽器都能用（`e6-t05`） |
| 本機錄影（`MediaRecorder` 能寫 `src/record/format.ts` 的一種格式、`canvas.captureStream`、`createMediaStreamDestination`、`indexedDB`） | `localRecording` | ● CI | ○ | ○ | ○ | ○ | ○ | 「更多 › 開始錄影」是灰的並說明「這個瀏覽器不能錄影…」（`e8-t03`）；別人錄影時照樣看得到紅燈與告知。格式：Chromium、Firefox 寫 WebM（VP9 或 VP8＋Opus），Safari 寫 MP4（H.264＋AAC；Safari 18.4 起也會寫 WebM，照偵測挑第一個）。CI：headless Chromium 實際錄影並下載（`e2e/local/recording.spec.ts`）；Firefox 只比偵測；Playwright 的 Linux WebKit 偵測為否（它的 MediaRecorder 不寫這些格式，`ENGINE_DIFFERENCES` 不比這格）。Safari、iOS 要實機確認下載與播放 |
| 通行密鑰（WebAuthn：`PublicKeyCredential`、`navigator.credentials.create`／`get`，只在 HTTPS 或 localhost） | `passkeys` | ● CI | ○ | ○ | ○ | ○ | ○ | `/me` 說「這個瀏覽器不能使用通行密鑰」，不能建立帳號或登入；不用帳號的一切照常（I2，`e1-t12`）。CI：headless Chromium 用虛擬驗證器註冊、登出、登入、建立固定會議室、以擁有者身分進房（`e2e/accounts.spec.ts`）。Firefox 只比偵測；Playwright 的 Linux WebKit 沒有 WebAuthn（`ENGINE_DIFFERENCES` 不比這格），Safari 13 起有。用平台驗證器（Face ID、Touch ID、Windows Hello、Android 螢幕鎖）與跨裝置（手機掃 QR code）要實機確認 |
| 分享畫面全螢幕（`document.fullscreenEnabled`） | `fullscreen` | ○ | ○ | ○ | ○ | ✕ | ○ | 分享格的控制列沒有全螢幕鈕、雙擊與 F 不作用；縮放與平移照常（`e3-t11`）。iPhone 的 Safari 只有 `<video>` 自己的全螢幕（iPad 有），標註疊不上去，所以不用。實機確認在 `DEPLOY.md` §5 第 29 步 |

**CI 每次跑什麼**（都不是必過的檢查，`DEPLOY.md` §7）：

| CI job | 瀏覽器 | 測什麼 |
| --- | --- | --- |
| `Preview / e2e` | Chromium × 3 | 經 SFU 互看互聽、開關、分享（替身）與分享音訊、simulcast 選層、聊天、主持人控制、等候室、進階噪音抑制、純音訊（`e2e/interop.spec.ts`） |
| `Preview / e2e-firefox` | Firefox ＋ Chromium；WebKit ＋ Chromium | 不同引擎經 SFU 互看互聽、靜音、互相看分享（替身；WebKit 分享時鏡頭先關，§3），並記下各自送出幾層 simulcast（`e2e/crossbrowser.spec.ts`） |
| `UI checks / browsers` | Chromium、Firefox、WebKit | 偵測結果對這張表、首頁、預先加入（假裝置、拒絕權限、沒有裝置）、兩人進房與聊天、參與者面板、手機大小的視窗（`e2e/local/browsers.spec.ts`；不需要部署、沒有 SFU） |
| `UI checks / a11y`、`visual` | Chromium | axe、鍵盤、Lighthouse、進階噪音抑制、視覺回歸 |

CI 不能代替實機的：真的鏡頭與麥克風、螢幕選擇器與分頁／系統音訊、回音、喇叭、權限對話框、手機的網址列與鍵盤、背景分頁、網路變差、螢幕閱讀器。

## 3. 已知的瀏覽器差異

**CI 看到的**（Playwright 1.64：Chromium 156、Firefox 157、WebKit 27.2，Linux）：

- **Firefox 的聊天輸入框把送出鈕擠出面板**（H6 修正）：聊天欄的表單是一欄的 grid，Firefox 依 textarea 預設 20 欄的寬度撐開那一欄，送出鈕跑到視窗外。改成 `grid-template-columns: minmax(0, 1fr)`（`src/components/ChatPanel.tsx`），`browsers.spec.ts` 檢查送出鈕整個在畫面內。
- **Firefox simulcast**：送出 `f`／`h`／`q` 三層 VP8，和 Chromium 一樣；Chromium 看 Firefox、Firefox 看 Chromium 都順（每秒約 20–30 幀）。
- **WebKit（Safari 的引擎）simulcast**：三層都協商成功、沒有退回單層，但剛加入時只有 `f` 有畫面（`h`、`q` 還是 0×0）；Chromium 照樣收得到 WebKit 的畫面與聲音。真的 Safari 會不會一直只送一層、別人選小格時拿到什麼，要實機確認（`DEPLOY.md` §5「Mac」那段）；風險表（`PRD/e2-media-core-webrtc-sfu.md`）的退路「Safari 退化為單層」仍成立，別人一定看得到。
- **WebKit 同時送鏡頭與分享會出事**（2026-11-06，#42；Playwright 的 Linux WebKit，真的 Safari 還不知道）：鏡頭開著時，別人鏡頭格子看到的是分享的畫面（每次都這樣），分享本身約四成多解不出來（14／31；發送端不理 PLI，沒有新的關鍵幀，SFU 有照送）；先關鏡頭 0／7。不是選層也不是 simulcast（只送一層照樣發生）。`e2e/crossbrowser.spec.ts` 因此在 WebKit 分享時先關鏡頭，**CI 不測 WebKit「鏡頭＋分享」**。細節在 ADR-001「WebKit 同時送鏡頭與分享」；要實機確認（`DEPLOY.md` §5「Mac」）。
- **Firefox 的 `getVideoPlaybackQuality()`** 對 MediaStream 的影片一直是 0（不是 LongTalk 的問題），測試改用 `requestVideoFrameCallback` 數幀。Playwright 在 Firefox 的 `fill()` 會觸發輸入法的 composition 事件，緊接著的 Enter 照設計只選字不送出（`chatText.ts` 的 `COMPOSITION_GRACE_MS`），測試改成逐字打。在 WebKit，從 init script 改 `navigator.mediaDevices` 上的方法沒有作用，測試的替身改放在 `MediaDevices.prototype`。
- **Firefox 的 console 警告**「Using five or more STUN/TURN servers slows down discovery」：Cloudflare TURN 回的 ICE 網址（濾掉 port 53 之後）有 5 個以上。目前不影響連線（CI 互通正常）；要不要少給幾個（例如只留 UDP 3478 與 TLS 443），等實機量過連線時間再決定。
- **安全標頭（I1，`public/_headers`）**：`UI checks / browsers` 的三個引擎都在這組 CSP（含 `script-src … 'wasm-unsafe-eval'`，RNNoise 的 wasm 要它；Chrome 97+、Firefox 102+、Safari 16+ 認得）、`Permissions-Policy`、`Cross-Origin-Opener-Policy: same-origin` 底下跑，首頁、預先加入、聊天、假裝置都正常，console 沒有警告。`Permissions-Policy` 只有 Chromium 真的照它做；Firefox 不認這個標頭（鏡頭、麥克風、分享照它自己的權限提示），Safari 只認一部分，所以 `camera=(self)` 這類限制在那兩個瀏覽器只是沒效果、不會擋到 LongTalk 自己。Turnstile（`challenges.cloudflare.com` 的 iframe）在 PR 預覽用 Cloudflare 的測試 key；Firefox、WebKit 經首頁開房都通過（`e2e-firefox`）。
- **Windows 版的 Playwright WebKit** 沒有 WebRTC 與 `mediaDevices`：會議室顯示「這個瀏覽器不能視訊通話」（`e2-t09` 的畫面），本機跑 `npm run test:browsers` 時 WebKit 的媒體測試會略過；CI（Linux）有 WebRTC 與假裝置，全部會跑。

**依文件，等實機**：

- **iOS Safari**：不能分享螢幕；分頁進背景時鏡頭會停；聲音要在使用者點擊後才能播放（預先加入頁的「加入」按鈕算一次點擊）；不能選喇叭。
- **Android Chrome**：不能分享螢幕；選喇叭的支援度不確定，app 以偵測結果為準。
- **Firefox**：116 版起才有 `setSinkId`；分享螢幕不能帶分頁或系統音訊（`shareAudio` 偵測為否，選擇器不要求音訊）；`degradationPreference` 忽略（文字／動態模式只靠 `contentHint` 與各層上限）。
- **Safari（macOS）**：分享螢幕沒有音訊；`setSinkId` 要實機確認（Playwright 的 WebKit 沒有）。
- **simulcast**：Chrome、Edge、Firefox 三層；Safari 見上；任何瀏覽器拒絕三層時退回一層（`CloudflareRealtimeTransport.publish`）。
- **AudioWorklet**（進階噪音抑制）：Chrome、Edge、Firefox、Safari 14.1+ 都有，只在安全環境（HTTPS）。Firefox 的麥克風取樣率不是 48 kHz 時 RNNoise 接不上，提示後關掉。
- **分享的防鏡像與簡報者縮圖（H5）**：`selfBrowserSurface`、`surfaceSwitching` 只有 Chromium（其他瀏覽器忽略）；認出「分享了別的會議分頁」靠 **Capture Handle**（`setCaptureHandleConfig`／`getCaptureHandle`，只有 Chromium；沒有時不提醒，分享照常）；認出「分享了會議所在的視窗」靠視窗軌的 label 是標題（Firefox；Chrome 的 label 不是標題，認不出來）；整個螢幕靠 `displaySurface`（Chrome、Edge、Firefox、Safari 都有）。縮圖與動態內容提示用 `ImageCapture.grabFrame()`（Chromium，分頁在背景也能取）或 `requestVideoFrameCallback`（Firefox、Safari，分頁在背景時可能不更新）；兩者都沒有就沒有縮圖、也沒有提示，分享照常。`DEPLOY.md` §5 第 24 步實測。
- **分享音訊（`getDisplayMedia` 的 audio，Chrome／Edge，D2）**：分頁音訊要在選擇器勾「同時分享分頁音訊」（預設勾）；整個螢幕的系統音訊只在 Windows、ChromeOS（macOS 依版本）；分享視窗通常沒有音訊。LongTalk 要求 `restrictOwnAudio`（系統音訊裡不含這個會議分頁自己播的聲音）與 `suppressLocalAudioPlayback: false`（分享者自己仍聽得到分頁）；不支援的瀏覽器會忽略這兩個選項。`DEPLOY.md` §5 第 10 步實測。
- **Battery Status API**：只有 Chromium（Chrome、Edge、Android Chrome）；Firefox、Safari 早就拿掉了，所以只有 Chromium 會出現「電量不多了」提示。

## 4. 實測紀錄

| 日期 | 瀏覽器 | 方式 | 結果 |
| --- | --- | --- | --- |
| 每個 PR | Chromium（Playwright，Linux，headless） | CI `Preview / e2e`：三個假裝置瀏覽器在 PR 預覽互通（`e2e/interop.spec.ts`） | 互看畫面有幀、聲音音量 > 0、靜音與關鏡頭對方看得到 |
| 每個 PR（H6 起） | Firefox 157、WebKit 27.2 各配一個 Chromium 156（Playwright，Linux） | CI `Preview / e2e-firefox`（`e2e/crossbrowser.spec.ts`） | 2026-11-03（#35）：互看每秒 ≥ 5 幀、聽得到、靜音後對方看到也聽到靜音、互相看分享；Firefox 送三層 simulcast，WebKit 協商三層、當下只有 `f` 有畫面 |
| 每個 PR（H6 起） | Chromium、Firefox、WebKit（Playwright，Linux） | CI `UI checks / browsers`（`e2e/local/browsers.spec.ts`） | 2026-11-03（#35）：偵測與 §2 的 Chrome、Firefox、Safari 欄一致；首頁、預先加入、拒絕權限、沒有裝置、兩人聊天、參與者、手機大小都通過；修了 Firefox 聊天送出鈕被擠出去 |
| 2026-11-02 | 電腦 Chrome（Windows，無鏡頭）＋ Android Chrome | 兩台裝置、PR #8 預覽 | 電腦看到並聽到手機；電腦 → 手機的視訊未測 |
| 2026-11-02 | Chrome（Windows，headless，假裝置） | PR #9、#10 預覽的一次性腳本 | 開關、換裝置、斷線重連都正常（細節在 PR） |
| 2026-11-03 | 電腦 Chrome（Windows）＋一支手機＋6 個 headless bot | 正式站，8 人房間（`NEXT.md` 第一次實機實測） | 8 人可以用；發現的問題已修（注音 Enter、評分、分享卡頓） |

**還沒有實機測過**：Edge、Firefox、Safari（macOS）、iOS Safari；Android Chrome 只測過加入與互看互聽。照 `DEPLOY.md` §5「實機測試計畫」跑完一台，就把那一欄的格子改成 ●、在上表加一列。

## 5. 怎麼更新這份

1. 新功能要用到瀏覽器 API：先在 `capabilities.ts` 加一個 key 與偵測函式，在 §2 加一列（第二欄寫 key），`npm test` 會檢查兩邊一致；`UI checks / browsers` 會在三個引擎裡比對新的那一列（Playwright 的引擎和品牌瀏覽器不同時，在 `browsers.spec.ts` 的 `ENGINE_DIFFERENCES` 寫原因）。
2. 在某個瀏覽器實測過：把對應格子改成 ●（只在 CI 跑過的寫 ● CI），在「實測紀錄」加一列（日期、裝置、PR、結果）。
3. 發現不支援或有問題：改成 ✕ 或寫進 §3，並讓 app 依偵測結果隱藏或說明。
