// What the home page needs of the Traditional Chinese dictionary (J4, RULES.md §1): in the first
// load of every page, so it stays small. Everything else is in zh-TW.ts, a chunk of its own that
// arrives with the room and the other lazy pages. A key is in one of the two, never both; a key
// here that en.home.ts lacks is a type error.
export const zhTWHome = {
  appName: 'LongTalk',
  tagline: '開著就不會斷的會議室',
  home: {
    intro: '貼一個連結，朋友點了就進來。不用裝 App、不用註冊、沒有 40 分鐘限制。',
    createRoom: '開一間房',
    creatingRoom: '開房中…',
    createRoomFailed: '開房失敗，請再試一次。',
    // Abuse protection (I1): Turnstile, the per-network limit, the blocklist
    verifying: '確認中…',
    createRoomVerifyFailed: '沒有通過真人驗證，請再試一次。',
    createRoomRateLimited: (minutes: number) =>
      `這個網路開房的次數太多了，請 ${minutes} 分鐘後再試。`,
    createRoomBlocked: '這個網路目前不能開房或加入會議室。',
    joinLabel: '會議室連結或代碼',
    joinPlaceholder: '貼上連結或輸入代碼',
    join: '加入',
    joinInvalid: '看不出這是哪一間房，請貼上完整連結或 10 碼代碼。',
    perks: [
      { title: '沒有時間限制', body: '聊到天亮也不會被切斷。房間在最後一個人離開後才關。' },
      { title: '免安裝、免註冊', body: '瀏覽器打開就能用。手機也行。' },
      { title: '螢幕分享與畫筆', body: '分享整個螢幕、視窗或分頁；之後還能在上面直接畫。' },
    ],
  },
  // The language menus (G1, e4-t15): each language is named in itself
  language: {
    label: '語言',
    section: '語言',
    names: { 'zh-TW': '繁體中文', en: 'English' },
  },
  // Light or dark (G5, AC-4.8): pages follow the choice, the room stays dark
  theme: {
    label: '外觀',
    names: { system: '跟隨系統', light: '淺色', dark: '深色' },
  },
  // A part of the app that could not be loaded (e4-t20): a network blip, or a new deployment
  // replaced the files this page was built with
  loadFailed: {
    title: '載入失敗，請重新整理',
    body: '可能是網路中斷，或 LongTalk 剛更新。重新整理後就能繼續。',
    reload: '重新整理',
  },
  // The app shell (G4, e4-t12): the install offer (home page only), new versions, offline
  pwa: {
    installLabel: '安裝 App',
    installTitle: '安裝 LongTalk',
    installBody: '裝到電腦或手機，下次從桌面或主畫面一鍵開會。',
    install: '安裝',
    installDismiss: '不用了',
    iosTitle: '把 LongTalk 加到主畫面',
    iosBody: '在 Safari 點「分享」，再選「加入主畫面」，下次就能像 App 一樣打開。',
    iosDismiss: '知道了',
    updateLabel: '新版本',
    update: '有新版本，重新整理就能使用。',
    // In a meeting: reloading goes straight back in (the session token, AC-1.2)
    updateRoom: '有新版本。重新整理後會直接回到這場會議，也可以等會議結束再說。',
    updateReload: '重新整理',
    updateLater: '稍後',
    offlineTitle: '你目前離線',
    offlineHome: '你目前離線。連上網路後才能開房或加入會議室。',
    offlineRoom: '進會議室需要網路。連上網路後會自動再試一次。',
  },
  // The link to /privacy and its loading line. The policy's own text is not here: src/privacy/
  // policy.*.ts, lazily loaded per language (RULES.md §1), so it stays out of the home page's JS
  privacy: {
    link: '隱私權政策',
    linkNewTab: '隱私權政策（在新分頁開啟）',
    loading: '載入中…',
  },
  account: {
    homeLink: '登入',
    homeLinkSignedIn: '我的帳號',
  },
  record: {
    leftover: (when: string) => `有一段沒有存好的錄影（${when} 開始）。`,
    leftoverDownload: '下載上次未完成的錄影',
    leftoverDelete: '刪除',
    leftoverDownloaded: '已下載上次未完成的錄影',
    leftoverDeleted: '已刪除上次未完成的錄影',
  },
}
