---
title: E6 — 音訊視訊品質
date: 2026-10-28
status: planned
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

- [ ] `e6-t01` 音訊三項約束開關與設定面板骨架（音訊／視訊／效能） · AC-6.1 · S · ← e2-t06
- [ ] `e6-t02` 進階噪音抑制：AudioWorklet ＋ wasm、能力偵測、CPU 門檻自動關 · AC-6.2 · M · ← e6-t01
- [ ] `e6-t03` 靜音中講話提醒 · AC-6.3 · S · ← e4-t05
- [ ] `e6-t04` HD 開關（上行檢查）與純音訊模式 · AC-6.4 · S · ← e2-t11, e6-t01
- [ ] `e6-t05` 省電模式（低幀率最低層、關動畫、不送 HD） · AC-6.4 · S · ← e6-t04, e2-t12

### M2

- [ ] `e6-t06` 背景模糊：segmentation 模型 lazy、管線、自動關閉 · M
- [ ] `e6-t07` 鏡像設定與可拖曳自拍格 · S
- [ ] `e6-t08` 音量條與每人接收音量 · S

## 風險與對策

| 風險 | 對策 |
| --- | --- |
| wasm 噪音抑制在低階筆電吃 CPU | 預設關、門檻自動關、省電模式強制關 |
| 背景模糊在 Safari 沒有 `MediaStreamTrackProcessor` | Canvas `captureStream` 後備或直接隱藏 |

## 未決問題

- [ ] **Q:** 進階噪音抑制用 RNNoise 還是其他模型（授權、體積）？
      **A:** _(e6-t02 前決定)_
