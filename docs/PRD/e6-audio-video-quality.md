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

- [x] `e6-t01` 音訊三項約束開關與設定面板骨架（音訊／視訊／效能） · AC-6.1 · #PRNUM
- [ ] `e6-t02` 進階噪音抑制：AudioWorklet ＋ wasm、能力偵測、CPU 門檻自動關 · AC-6.2 · M · ← e6-t01
- [x] `e6-t03` 靜音中講話提醒 · AC-6.3 · #PRNUM
- [x] `e6-t04` HD 開關（上行檢查）與純音訊模式 · AC-6.4 · #PRNUM
- [ ] `e6-t05` 省電模式（低幀率最低層、關動畫、不送 HD） · AC-6.4 · S · ← e6-t04, e2-t12

### M2

- [ ] `e6-t06` 背景模糊：segmentation 模型 lazy、管線、自動關閉 · M
- [ ] `e6-t07` 鏡像設定與可拖曳自拍格 · S
- [ ] `e6-t08` 音量條與每人接收音量 · S

## H3 的做法與決定（#PRNUM）

- **設定面板**（`src/components/SettingsDialog.tsx`）：「更多 › 設定…」與預先加入頁的「設定」；電腦是對話框、手機是全螢幕抽屜；三個分頁「音訊」（麥克風、喇叭、聲音處理）、「視訊」（鏡頭、HD）、「效能」（純音訊模式；H4 加省電模式與進階噪音抑制）。改了立刻生效，沒有「儲存」鈕。裝置選單和預先加入頁共用 `DeviceSelect`。
- **聲音處理**（`src/media/audioProcessing.ts`）：三個開關預設全開（瀏覽器本來的預設），只把關掉的那幾個放進 `getUserMedia`。通話中切換先對開著的麥克風 `applyConstraints`，再讀 `getSettings` 確認瀏覽器真的改了；沒改（Chrome 常見）就用新的設定重開同一支麥克風（靜音的話保持靜音），送出的軌經 `MediaTransport.replaceTrack` 換掉，**不重新協商**。`getSupportedConstraints` 不認得的開關不顯示（`capabilities.ts` 的 `audioProcessing`）。設定記在 localStorage（`longtalk.media`），預先加入頁與會議室共用。
- **靜音中講話提醒**（`src/media/mutedSpeech.ts`、`src/room/useMutedSpeechHint.ts`）：門檻和講話外框一樣（`SPEAKING_THRESHOLD`），持續 2 秒（字與字之間 ≤ 0.4 秒的停頓照算）就出現「你目前是靜音」＋「取消靜音」，8 秒沒按就收起；出現後 30 秒內不再出現；按住說話時與放開後 1.5 秒內不出現。**隱私**：靜音時麥克風的軌 `enabled = false`、sender 送 null（什麼都不送）；為了在本機聽得到，提醒用這支麥克風的 `clone()` 接到一個不連到任何輸出的 analyser，clone 從不交給 RoomMedia 或 transport，取消靜音或離開就停掉。
- **HD**：PRD 原本寫「720p 預設、HD 開 1080p」；H1 已經把鏡頭擷取改成 720p、上行約 1.7 Mbps，所以 H3 改成**開 HD＝送 720p 那層、關＝最高 360p**（`MediaTransport.setTopLayer`：simulcast 的 `f` 層 `active: false`；單層時縮一半）。擷取保持 720p，開回來不用重開鏡頭。**預設**：電腦開、觸控為主的裝置（手機、平板）關（上行常是行動網路、也省電）；使用者選過就照選的，記在 localStorage。1080p 不做（多數人的鏡頭與上行都不夠，需要時再加 task）。
- **上行檢查**（`src/media/uplink.ts`）：HD 開著且鏡頭在送時每 5 秒讀一次 `MediaTransport.getUplink`（sender 的 `qualityLimitationReason` 與 candidate-pair 的 `availableOutgoingBitrate`）；前 15 秒不判斷（估計值還在爬），之後連續 3 次「頻寬受限」或估計值 < 1.5 Mbps 就暫停 HD（`hdLimited`，提示一次），1 分鐘後再試，每次又被擋就加倍（最多 8 分鐘）；自己重新打開 HD 會立刻再試。
- **純音訊模式**（`RoomMedia.setAudioOnly`、`useRoomMedia` 的 `audioOnly`／`setAudioOnly`）：別人的鏡頭與分享畫面全部退訂（SFU 不再送），聲音（含分享音訊）照常；自己的鏡頭 sender 送 null、回報 muted，會議室頁同時關掉鏡頭（燈熄）、結束時再打開（原本開著的話）。自己的螢幕分享照常。不記憶（下一場會議不該莫名其妙沒有畫面），但預先加入頁的設定可以選「進房就是純音訊」。H2 的頻寬自適應要建議純音訊時，呼叫同一個 `setAudioOnly`。和本月流量的 `usage: audioOnly`（e11-t13）是兩件事。

## 風險與對策

| 風險 | 對策 |
| --- | --- |
| wasm 噪音抑制在低階筆電吃 CPU | 預設關、門檻自動關、省電模式強制關 |
| 背景模糊在 Safari 沒有 `MediaStreamTrackProcessor` | Canvas `captureStream` 後備或直接隱藏 |

## 未決問題

- [ ] **Q:** 進階噪音抑制用 RNNoise 還是其他模型（授權、體積）？
      **A:** _(e6-t02 前決定)_
