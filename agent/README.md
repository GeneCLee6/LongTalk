# LongTalk 代理（桌面端）

被控端電腦上的小程式（E9，Tauri v2）。N2（`e9-t02`、`e9-t03`）做到：用會議室連結（或代碼）＋一次性配對碼加入房間、發布前的本機確認、托盤、把這台電腦的螢幕分享到會議室（可以挑哪一個螢幕）。**還不能被控制**：控制請求、同意對話框、注入滑鼠鍵盤是 N3–N5。

威脅模型與每個設計決定在 [`docs/PRD/f-remote-control-security.md`](../docs/PRD/f-remote-control-security.md)（§5.1 配對、§5.8 本機攻擊面、§5.9 更新）；通訊協定在 [`shared/control.ts`](../shared/control.ts)。

## 結構

| 位置 | 內容 |
| --- | --- |
| `src-tauri/src/session.rs` | 會話狀態機與**發布前的本機確認**（T-01a 的單元測試在這裡）：`agentWelcome` 之後、按「加入」之前什麼都不能發布；「分享我的螢幕」預設關；取消就離開；按鈕 1 秒後才有效 |
| `src-tauri/src/socket.rs` | 房間的 WebSocket（`/api/rooms/<id>/agent`），由 Rust 持有：代理 token 只在 Rust 的記憶體裡，頁面拿到的 `agentWelcome` 沒有 token；頁面送的每一則都先問 `session.rs` |
| `src-tauri/src/origin.rs` | 唯一的網域（寫死在建置裡）、房號與 API 路徑的白名單 |
| `src-tauri/src/lib.rs` | 指令（IPC 白名單在 `build.rs`、授權在 `capabilities/main.json`）、`api_fetch`（SFU 代理與 TURN，由 Rust 加 token）、單一實例、關視窗縮到托盤 |
| `src-tauri/src/tray.rs` | 托盤：狀態、「打開 LongTalk 代理」「分享我的螢幕」「離開房間」「結束」 |
| `src-tauri/src/updater.rs` | 自動更新（`updater` feature，預設關，見下面「擁有者要做的事」） |
| `ui/` | 打包進代理的頁面（Vite ＋ React）：加入表單、連線中、本機確認、房間。擷取螢幕用 WebView 的 `getDisplayMedia`，發布用和網頁版同一個 `MediaTransport`（`src/media/CloudflareRealtimeTransport.ts`，CLAUDE.md 規則 2），它的 HTTP 經 Rust 的 `api_fetch` |
| `ui/src/i18n.ts` | 代理的介面文字（繁中＋英文），`npm run lint` 的 `scripts/literals.ts` 也掃 `agent/ui/src` |
| `tests/agent/`（repo 根目錄） | 頁面端的純函式（連結只收自己的網域、關閉碼的說明、字典）的 Vitest |

為什麼確認的狀態機放 Rust 而不是 TypeScript：Rust 是代理的網路邊界（socket 與每個 SFU 呼叫都經過它），在這裡擋，頁面裡的 bug 或被注入的腳本也發布不了；托盤的開關讀同一份狀態；N4 的輸入注入也要由同一個地方把關。§8 的 T-01a 也指定 Rust 單元測試。

## 開發

需要 Node 22、Rust stable（`rustup`）、Windows 要有 Visual Studio Build Tools（C++）與 WebView2（Windows 11 內建）；macOS 要 Xcode Command Line Tools。

```bash
npm ci                 # 根目錄；agent/ui 是 npm workspace，@tauri-apps/api 一起裝
npm run agent:dev      # Vite（localhost:5174）＋ Tauri 視窗，改 ui/ 會即時更新
npm run agent:test     # cargo test（session.rs、origin.rs、socket.rs）
npm run agent:ui:build # 只建頁面（agent/ui/dist，已 gitignore）
npm run agent:build    # 安裝檔：agent/src-tauri/target/release/bundle/
npx vitest run tests/agent
```

- 預設連正式網域 `https://longtalk.genelee-pro.workers.dev`。要連 PR 預覽，**建置時**設 `LONGTALK_AGENT_ORIGIN=https://<預覽網域> npm run agent:dev`（或 `agent:build`）；執行時沒有任何設定能改網域，貼別的網域的連結會顯示「這不是 LongTalk 的連結」。
- 代理不聽任何埠：所有連線都是主動連出去的 WSS、HTTPS 與 WebRTC（§5.8，T-19 的實機檢查：執行中 `netstat -ano | findstr <pid>` 不該有 LISTENING）。
- 自訂 URL scheme（`longtalk-agent://`）N2 沒做；做的時候只能預填加入表單（§5.8）。
- 圖示從 `src-tauri/icons/source.svg`（取自 `docs/design/logo/icon-maskable.svg`）產生：`npx tauri icon agent/src-tauri/icons/source.svg -o agent/src-tauri/icons`，再刪掉 `android/`、`ios/` 與 `Square*`。

## 發布

`.github/workflows/agent.yml`：推 `agent-v*` tag（或手動執行並填 tag）→ Windows 與 macOS（universal）建置 → 放到 **草稿** GitHub Release，附 `SHA256SUMS.txt` 並寫進說明。擁有者看過草稿再按發布。

```bash
# 版本號在 agent/src-tauri/tauri.conf.json 與 Cargo.toml 的 version，兩個一起改
git tag agent-v0.1.0 && git push origin agent-v0.1.0
```

Windows 與 macOS 的安裝檔**沒有作業系統簽章**（§5.9：不買 Authenticode、不做 notarization）。朋友第一次執行會看到 SmartScreen／Gatekeeper 警告，所以只從 GitHub Releases 下載，並比對 SHA-256：

- Windows：`certutil -hashfile "LongTalk Agent_0.1.0_x64-setup.exe" SHA256`（另有 `.msi`）
- macOS：`shasum -a 256 "LongTalk Agent_0.1.0_universal.dmg"`

## 擁有者要做的事：開啟自動更新

自動更新用 Tauri updater 的簽章（和作業系統簽章無關、免費）：公鑰編進代理，私鑰只放 GitHub secret，代理只裝簽章對得上、版本較新的更新。**做完這三步之前，代理不會檢查更新**（`updater` feature 沒開）。

1. 產生金鑰（在自己的電腦，私鑰不要進 repo）：

   ```bash
   npx tauri signer generate -w ~/.tauri/longtalk-agent.key
   ```

   設一個密碼。會產生 `longtalk-agent.key`（私鑰）與 `longtalk-agent.key.pub`（公鑰）。
2. 把 `.pub` 檔的**內容**貼到 `agent/src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`（取代 `REPLACE_WITH_…`），開 PR 合併。
3. GitHub → Settings → Secrets and variables → Actions，新增：
   - `TAURI_SIGNING_PRIVATE_KEY`：私鑰檔的內容
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：第 1 步的密碼

之後的 `agent-v*` 版本會用 `--features updater` 建置、簽章，Release 多一個 `latest.json`（代理從 `https://github.com/GeneCLee6/LongTalk/releases/latest/download/latest.json` 讀）。代理啟動 15 秒後檢查一次，**只在沒加入任何房間時**下載、安裝並重新啟動。私鑰遺失就無法再發更新給已安裝的代理（只能請大家手動重裝），請備份。

## 接下來（N3–N5）

- **N3**（`e9-t04`、`e9-t05`）：控制請求與同意對話框（系統層級、預設焦點在拒絕、1 秒內不收點擊）、全員提示、紅框與「中斷」鈕；`controlForward` 經 RoomDO 轉送、序號與速率。
- **N4**（`e9-t06`、`e9-t07`）：Windows／macOS 注入滑鼠鍵盤與輸入法文字、Esc 連按三下與托盤中斷、代理日誌；代理視窗忽略注入的輸入（`lib.rs` 的 `guard_against_injected_input` 是預留的位置）。
- **N5**（`e9-t08`）：macOS 權限引導、Linux、安裝包與更新的實測（T-20）。
