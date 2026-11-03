---
title: E6 — 音訊視訊品質
date: 2026-10-28
status: in progress
epic: E6
owner: GeneCLee6
milestones: [M1, M2]
depends_on: [E2]
---

## 背景

E2 讓媒體送到；E6 讓它好聽好看。Zoom 的「背景雜音抑制」「HD」「省電」是朋友會感覺到差異的地方。瀏覽器已經內建噪音抑制、回音消除、自動增益（`getUserMedia` 約束），M1 先把這三個做成可開關，再加 WebAssembly 的進階噪音抑制（RNNoise 類）；M2 做背景模糊。

## 目標

- M1：音訊三項可開關且預設開；進階噪音抑制（能力偵測）；靜音中講話提醒；HD 開關；純音訊模式；省電模式。
- M2：背景模糊（效能不足自動關）；鏡像與自拍設定；音量指示與個別音量。

## 非目標

- 虛擬背景圖片合成、美顏、濾鏡。
- 伺服器端音訊處理（全部在本機）。

## 需求

- 音訊約束：`noiseSuppression`、`echoCancellation`、`autoGainControl` 三個開關在設定面板；切換即時 `applyConstraints`。
- 進階噪音抑制：AudioWorklet ＋ RNNoise（wasm）在發送端處理；能力偵測（AudioWorklet、SIMD）；CPU 高於門檻自動關並提示；預設關，設定可開。
- 靜音中講話提醒：靜音時本機 analyser 偵測持續 2 秒有語音 → 提示「你被靜音了」（Zoom 同款）。
- HD 開關：cam 最高層 720p（預設）或 1080p（開 HD；需上行 ≥ 3 Mbps 才允許）；純音訊模式：不收任何視訊、不送自己視訊、版面變頭像；省電模式：收 15 fps 最低層、關動畫、不送 HD。
- 背景模糊（M2）：selfie segmentation（MediaPipe 或 ONNX 模型，lazy 載入）在 `OffscreenCanvas`／`MediaStreamTrackProcessor`；fps 低於 15 自動關閉並提示；不支援的瀏覽器隱藏。
- 鏡像與自拍：自己預覽鏡像（預設開）、送出不鏡像；自拍格固定在角落可拖曳。
- 音量：每人名牌音量條（E2 level）；對每個人可調接收音量 0–200%（本機 GainNode）。

## 設計方向

- `src/media/audioPipeline.ts`：`getUserMedia` → 可選 Worklet → 送出軌；所有設定存 localStorage。
- `src/media/videoPipeline.ts`：cam → 可選 segmentation → 送出軌；模糊模組 lazy。
- 設定面板在「更多 → 設定」，分「音訊」「視訊」「效能」三頁。

## 驗收條件

- [ ] AC-6.1 — 噪音抑制、回音消除、自動增益可開關且即時生效；預設全開。
- [ ] AC-6.2 — 進階噪音抑制可開；鍵盤聲與風扇聲在接收端明顯降低（錄音比對）；CPU 超過門檻自動關並提示；不支援時隱藏。
- [ ] AC-6.3 — 靜音中講話 2 秒出現提示；提示可一鍵取消靜音。
- [ ] AC-6.4 — HD 開關（上行不足不允許）、純音訊模式、省電模式三者可用，且 E2 統計面板反映變化。
- [ ] AC-6.5 — 背景模糊可開；fps < 15 自動關閉並提示；不支援時隱藏；JS 模組 lazy 載入。
- [ ] AC-6.6 — 鏡像預覽、自拍格可拖曳；每人音量條；對每個人可調接收音量。

## Task 拆分

### M1

- [x] `e6-t01` 音訊三項約束開關與設定面板骨架（音訊／視訊／效能） · AC-6.1 · #32
- [x] `e6-t02` 進階噪音抑制：AudioWorklet ＋ wasm、能力偵測、CPU 門檻自動關 · AC-6.2 · #33
- [x] `e6-t03` 靜音中講話提醒 · AC-6.3 · #32
- [x] `e6-t04` HD 開關（上行檢查）與純音訊模式 · AC-6.4 · #32
- [x] `e6-t05` 省電模式（低幀率最低層、關動畫、不送 HD） · AC-6.4 · #33

### M2

- [ ] `e6-t06` 背景模糊：segmentation 模型 lazy、管線、自動關閉 · M
- [ ] `e6-t07` 鏡像設定與可拖曳自拍格 · S
- [ ] `e6-t08` 音量條與每人接收音量 · S

## H3 的做法與決定（#32）

- **設定面板**（`src/components/SettingsDialog.tsx`）：「更多 › 設定…」與預先加入頁的「設定」；電腦是對話框、手機是全螢幕抽屜；三個分頁「音訊」（麥克風、喇叭、聲音處理）、「視訊」（鏡頭、HD）、「效能」（純音訊模式；H4 加省電模式與進階噪音抑制）。改了立刻生效，沒有「儲存」鈕。裝置選單和預先加入頁共用 `DeviceSelect`。
- **聲音處理**（`src/media/audioProcessing.ts`）：三個開關預設全開（瀏覽器本來的預設），只把關掉的那幾個放進 `getUserMedia`。通話中切換先對開著的麥克風 `applyConstraints`，再讀 `getSettings` 確認瀏覽器真的改了；沒改（Chrome 常見）就用新的設定重開同一支麥克風（靜音的話保持靜音），送出的軌經 `MediaTransport.replaceTrack` 換掉，**不重新協商**。`getSupportedConstraints` 不認得的開關不顯示（`capabilities.ts` 的 `audioProcessing`）。設定記在 localStorage（`longtalk.media`），預先加入頁與會議室共用。
- **靜音中講話提醒**（`src/media/mutedSpeech.ts`、`src/room/useMutedSpeechHint.ts`）：門檻和講話外框一樣（`SPEAKING_THRESHOLD`），持續 2 秒（字與字之間 ≤ 0.4 秒的停頓照算）就出現「你目前是靜音」＋「取消靜音」，8 秒沒按就收起；出現後 30 秒內不再出現；按住說話時與放開後 1.5 秒內不出現。**隱私**：靜音時麥克風的軌 `enabled = false`、sender 送 null（什麼都不送）；為了在本機聽得到，提醒用這支麥克風的 `clone()` 接到一個不連到任何輸出的 analyser，clone 從不交給 RoomMedia 或 transport，取消靜音或離開就停掉。
- **HD**：PRD 原本寫「720p 預設、HD 開 1080p」；H1 已經把鏡頭擷取改成 720p、上行約 1.7 Mbps，所以 H3 改成**開 HD＝送 720p 那層、關＝最高 360p**（`MediaTransport.setTopLayer`：simulcast 的 `f` 層 `active: false`；單層時縮一半）。擷取保持 720p，開回來不用重開鏡頭。**預設**：電腦開、觸控為主的裝置（手機、平板）關（上行常是行動網路、也省電）；使用者選過就照選的，記在 localStorage。1080p 不做（多數人的鏡頭與上行都不夠，需要時再加 task）。
- **上行檢查**（`src/media/uplink.ts`）：HD 開著且鏡頭在送時每 5 秒讀一次 `MediaTransport.getUplink`（sender 的 `qualityLimitationReason` 與 candidate-pair 的 `availableOutgoingBitrate`）；前 15 秒不判斷（估計值還在爬），之後連續 3 次「頻寬受限」或估計值 < 1.5 Mbps 就暫停 HD（`hdLimited`，提示一次），1 分鐘後再試，每次又被擋就加倍（最多 8 分鐘）；自己重新打開 HD 會立刻再試。
- **純音訊模式**（`RoomMedia.setAudioOnly`、`useRoomMedia` 的 `audioOnly`／`setAudioOnly`）：別人的鏡頭與分享畫面全部退訂（SFU 不再送），聲音（含分享音訊）照常；自己的鏡頭 sender 送 null、回報 muted，會議室頁同時關掉鏡頭（燈熄）、結束時再打開（原本開著的話）。自己的螢幕分享照常。不記憶（下一場會議不該莫名其妙沒有畫面），但預先加入頁的設定可以選「進房就是純音訊」。H2 的頻寬自適應要建議純音訊時，呼叫同一個 `setAudioOnly`。和本月流量的 `usage: audioOnly`（e11-t13）是兩件事。

## H4 的做法與決定（#33）

- **模型與套件**：RNNoise（xiph，BSD-3-Clause）。wasm 用 [shiguredo/rnnoise-wasm](https://github.com/shiguredo/rnnoise-wasm) 從 xiph/rnnoise 編出來的那兩個檔（一般版 153 kB、SIMD 版 157 kB，gzip 後各約 114 kB），從 npm 套件 `@sapphi-red/web-noise-suppressor` 0.4.1（MIT）取得；**只用它的兩個 wasm**，AudioWorklet 是我們自己寫的（`src/media/rnnoise.worklet.ts`、`rnnoiseCore.ts`），不用 emscripten 的 glue（wasm 只要三個 import：記憶體內複製、長大記憶體、assert）。授權全文在 `THIRD_PARTY_NOTICES.md`，建置時一併放到 `/third-party-notices.txt`。沒有付費或從網路載入的模型，wasm 從我們自己的 `/assets/` 來。比較過：`@jitsi/rnnoise-wasm`（Apache-2.0，非同步那份還是 RNNoise 0.1 的舊模型）、`@shiguredo/rnnoise-wasm` 最新版（Apache-2.0，wasm 內嵌成 4.8 MB 的 JS）。
- **管線**（`src/media/noiseSuppression.ts`）：麥克風 → `AudioContext`（48 kHz、`interactive`）→ RNNoise worklet（單聲道，`channelCountMode: explicit`）→ `MediaStreamDestination`；它的軌經 `RoomMedia.setLocal` → `MediaTransport.replaceTrack` 取代麥克風，**不重新協商**。換麥克風（換裝置、為了聲音處理開關重開）只換管線的輸入，送出的軌不變。RNNoise 一幀 480 樣本（10 ms）；worklet 一次給 128，`Framer` 湊滿 480 處理後延遲 448 樣本（9.3 ms，128·k mod 480 的最大值：再少一個就會斷音）播出。加上 context 的 `baseLatency`（headless Chromium 10 ms），**總共多約 19 ms**。有 SIMD 的瀏覽器載入 SIMD 版。
- **Lazy**：管線的程式、worklet 與 wasm 只在第一次打開時載入（`useNoiseSuppression` 的 `import()`），不算在會議室的初始 JS（`npm run budget`：會議室 185.9 → 188.4 kB、首頁 122.3 → 123.2 kB，多的是開關、字典與 hook；管線 chunk 1.3 kB gzip、worklet 3 kB、wasm 約 114 kB gzip 都在 lazy 那邊）。
- **還沒準備好時照送原本的麥克風**：wasm 載入中，或 `AudioContext` 沒在跑（重新整理直接回到房間、沒有使用者手勢；Safari 來電時）都送麥克風本身，下一次點擊或按鍵就恢復；設定頁寫「點一下頁面…」。所以開這個開關，對方**不會有一刻聽不到**。
- **瀏覽器自己的噪音抑制**：進階的開著（而且沒被省電模式擋住）時**關掉瀏覽器的**，設定頁那個開關變灰、寫「由它處理噪音」；關掉進階的就恢復你原本的選擇。理由：兩個疊在一起會讓人聲發悶，RNNoise 也比較適合處理沒被壓過的聲音，還省一份 CPU。回音消除與自動增益照常（在 RNNoise 之前）。
- **CPU 門檻**（`src/media/noiseLoad.ts`）：worklet 每秒回報 RNNoise 花的時間占音訊時間的比例與最慢的一幀；一秒內 > 35 %，或有一幀 > 2.4 ms（2.7 ms 的 render quantum 快用完，會聽到爆音），算超標；**連續 5 秒超標**就關掉、提示「你的裝置忙不過來，已關閉進階噪音抑制」，設定也記成關（下次不會再試）。worklet 失敗（`processorerror`）或開不起來（Firefox 的麥克風不是 48 kHz 時接不上）也一樣關掉並提示。實測：Node 裡一幀 0.13 ms（一般版）／0.09 ms（SIMD 版），約 1 % 的即時；headless Chromium（Windows）在 worklet 裡量到 0.1–0.9 %。Chromium 的 AudioWorklet 沒有 `performance.now()`，只能用 `Date.now()`（1 ms 解析度），每秒加總仍是不偏的估計。
- **能力偵測**（`capabilities.ts` `advancedNoiseSuppression`）：`AudioContext.prototype.audioWorklet`（只有安全環境有）、`AudioWorkletNode`、`createMediaStreamDestination`、`WebAssembly`；**不需要** `SharedArrayBuffer`（不必 cross-origin isolation）。沒有就不顯示開關。
- **靜音、按住說話、靜音中講話提醒**照舊：靜音時房間送 null（不管是哪一條軌）；提醒聽的是麥克風本身的 `clone()`。
- **省電模式**（`src/media/powerSaving.ts`）：在「效能」頁，記在 localStorage（像 HD，是這台裝置的選擇）。開著時：收到的每個視訊都要最低層（選層預算設成 0，`layers.ts` 把鏡頭降到 180p 15 fps、分享降到一半大小 15 fps，鏡頭先降）；自己的鏡頭**不送 HD**（不管 HD 開關，`setTopLayer('medium')`）且擷取上限 15 fps（`applyConstraints`，少擷取也少編碼；本月低畫質的上限照留）；動畫全關（`MotionOffContext` 與 `html[data-motion='off']`，走減少動態效果的同一條路：反應不飄、抽屜不滑、換頁直接跳）；進階噪音抑制暫停（選擇保留，關掉省電模式就回來）。關掉時全部恢復，往上換層照樣要預算的餘裕（`UPGRADE_HEADROOM`）。
- **電量提示**：有 Battery Status API 的瀏覽器（Chromium）電量 ≤ 20 % 且沒在充電時，一場會議提示一次「電量不多了：可以在…開啟省電模式」；**不自動打開**（可能馬上就插電，或比起電量更在意畫面）。其他瀏覽器不提示（`capabilities.ts` `battery`）。
- **統計面板**多一段「模式」：HD（開／關／暫停（上傳不夠）／關（省電模式））、省電模式、純音訊模式、進階噪音抑制（開・處理器 %・延遲）。

## 風險與對策

| 風險 | 對策 |
| --- | --- |
| wasm 噪音抑制在低階筆電吃 CPU | 預設關、門檻自動關、省電模式強制關 |
| 背景模糊在 Safari 沒有 `MediaStreamTrackProcessor` | Canvas `captureStream` 後備或直接隱藏 |

## 未決問題

- [x] **Q:** 進階噪音抑制用 RNNoise 還是其他模型（授權、體積）？
      **A:** RNNoise（BSD-3-Clause），編成 wasm 在 AudioWorklet 裡跑；只在打開時 lazy 載入；不用付費或從網路載入的模型，wasm 放在我們自己的資產裡（使用者 2026-11-03 拍板）。套件與體積見「H4 的做法與決定」。
