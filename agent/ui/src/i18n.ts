// The agent's interface text, zh-TW and English (CLAUDE.md rule 5: text only in a dictionary; this
// is the agent's own, small enough to stay one file). zh-TW is the source and defines the type;
// the language follows the system (navigator.language), like the tray (src-tauri/src/tray.rs).

const zhTW = {
  appName: 'LongTalk 代理',
  join: {
    title: '加入會議室',
    intro: '讓會議室裡的人看到這台電腦的螢幕。在會議室裡按「連接我的電腦」取得配對碼。',
    link: '會議室連結或代碼',
    linkPlaceholder: 'https://…/r/…',
    pairing: '配對碼',
    pairingHint: '8 個英數字，5 分鐘內有效',
    device: '這台電腦的名稱',
    deviceHint: '會議室裡會顯示這台電腦是誰的，以及這個名稱',
    submit: '加入',
  },
  problems: {
    foreignLink: '這不是 LongTalk 的連結',
    badRoom: '看不懂這個連結或代碼',
    badPairing: '配對碼是 8 個英數字，例如 7K3M-Q9TD',
    badDevice: '請填這台電腦的名稱（最多 40 個字）',
    pairingFailed: '配對碼不對或已過期，請在會議室裡重新產生一組',
    expired: '這次連線已失效，請在會議室裡重新產生配對碼',
    replaced: '這台電腦已在別的地方重新連上會議室',
    versionMismatch: '這個代理的版本太舊，請更新後再試',
    roomNotFound: '找不到這個會議室，或會議已經結束',
    roomFull: '會議室已經滿了',
    rateLimited: '嘗試太多次，請過幾分鐘再試',
    removed: '你已被移出會議室',
    ended: '會議已經結束',
    lost: '連線中斷太久，已離開會議室',
    failed: '連不上 LongTalk，請檢查網路後再試',
  },
  connecting: '連線中…',
  /** A room without a name, as the web app shows it (src/i18n room.defaultName) */
  roomName: (roomName: string | null, createdBy: string | null) =>
    roomName ?? (createdBy ? `${createdBy} 的房間` : '會議室'),
  confirm: {
    title: '確認加入',
    question: (ownerName: string, roomName: string) =>
      `${ownerName} 發的配對碼，要加入『${roomName}』嗎？房間裡的人都會看到你的螢幕。`,
    warning: '如果是不認識的人在電話或訊息裡要你輸入這組碼，請按取消。',
    join: '加入',
    cancel: '取消',
  },
  room: {
    joined: (roomName: string) => `已加入『${roomName}』`,
    owner: (ownerName: string) => `在會議室裡顯示為「${ownerName} 的電腦」`,
    reconnecting: '連線中斷，正在重新連線…',
    share: '分享我的螢幕',
    sharing: '正在分享你的螢幕，房間裡的人都看得到',
    notSharing: '目前沒有分享螢幕',
    pickHint: '打開後選擇要分享的螢幕（有多個螢幕時可以挑一個）',
    leave: '離開房間',
    // N5 (e9-t09): another screen while sharing; which one the controller's pointer aims at
    switchScreen: '換一個螢幕',
    whichScreen: '你分享的是哪一個螢幕？',
    whichScreenHint:
      '有幾個螢幕一樣大，選你分享的那一個，對方的滑鼠才會點在對的地方。控制中不能改。',
    screenLabel: (n: number, width: number, height: number, primary: boolean) =>
      `螢幕 ${n}（${width}×${height}${primary ? '，主螢幕' : ''}）`,
  },
  // N5 (e9-t08): what the system must allow before remote control works here
  permissions: {
    title: '遠端控制需要的系統權限',
    intro: '這台電腦要先在系統設定裡允許下面幾項，別人請求控制時才有作用。',
    screen: '螢幕錄製：讓會議室看到你的螢幕',
    accessibility: '輔助使用：讓對方的滑鼠和鍵盤有作用（沒有的話什麼都不會發生）',
    inputMonitoring: '輸入監控（選用）：連按三下 Esc 中斷控制；沒給也可以按「中斷」',
    open: '打開設定',
    granted: '已允許',
    afterUpdate: '更新代理之後，系統可能要你重新允許一次。',
    noX11:
      '這台電腦用的是 Wayland，代理不能操作滑鼠和鍵盤；要遠端控制，請在登入畫面改用「X11」或「Xorg」工作階段。',
  },
  shareProblems: {
    denied: '系統不允許擷取螢幕，請到系統設定開放權限',
    unsupported: '這台電腦無法分享螢幕',
    failed: '分享螢幕失敗，請再試一次',
    full: '會議室裡同時分享的人數已滿',
    audioOnly: '本月額度快用完了，會議室暫時不能分享畫面',
    fromTray: '請在這個視窗打開「分享我的螢幕」，選擇要分享的螢幕',
  },
  control: {
    asks: (name: string) => `${name} 想控制這台電腦`,
    inRoom: (room: string) => `在『${room}』裡`,
    nameNote: '名字是對方自己取的。',
    consequence: '允許後，對方可以用你的滑鼠和鍵盤做任何事；房間裡的人都看得到你的螢幕。',
    closesIn: (time: string) => `${time} 後自動拒絕`,
    allow10: '允許 10 分鐘',
    allowUntilStop: '允許直到我中斷',
    deny: '拒絕',
    mute: '不再接受請求',
    muteFor: '多久不接受請求',
    minutes: (n: number) => `${n} 分鐘`,
    reconfirm: (name: string) => `還要繼續讓 ${name} 控制嗎？`,
    reconfirmNote: '「允許直到我中斷」每小時會再問一次。沒有回答就會結束控制。',
    keepGoing: '繼續',
    stop: '中斷',
    controlling: (name: string) => `${name} 正在控制這台電腦`,
    pressed: (name: string, combo: string) => `${name} 按了 ${combo}`,
    failed: '沒有送出，請再按一次',
    // N5 (e9-t09): pasting text from the controller, off unless ticked here
    allowPaste: '也允許對方把文字貼到這台電腦的剪貼簿',
    allowPasteNote: '只會從對方那邊放進來，不會讀你的剪貼簿。之後隨時可以關掉。',
    pasteOn: '對方可以貼上文字',
    pasteOff: '不允許貼上',
    pasted: (name: string, chars: number) => `${name} 放了 ${chars} 個字到你的剪貼簿`,
  },
}

export type AgentStrings = typeof zhTW

const en: AgentStrings = {
  appName: 'LongTalk agent',
  join: {
    title: 'Join a room',
    intro:
      'Lets the people in a room see this computer’s screen. Get a pairing code in the room with “Connect my computer”.',
    link: 'Room link or code',
    linkPlaceholder: 'https://…/r/…',
    pairing: 'Pairing code',
    pairingHint: '8 letters and digits, valid for 5 minutes',
    device: 'This computer’s name',
    deviceHint: 'The room shows whose computer this is, and this name',
    submit: 'Join',
  },
  problems: {
    foreignLink: 'This is not a LongTalk link',
    badRoom: 'That link or code does not look like a room',
    badPairing: 'A pairing code is 8 letters and digits, like 7K3M-Q9TD',
    badDevice: 'Enter this computer’s name (up to 40 characters)',
    pairingFailed: 'The pairing code is wrong or has expired: make a new one in the room',
    expired: 'This connection has expired: make a new pairing code in the room',
    replaced: 'This computer connected to the room again from somewhere else',
    versionMismatch: 'This agent is too old: update it and try again',
    roomNotFound: 'No such room, or the meeting has ended',
    roomFull: 'The room is full',
    rateLimited: 'Too many tries: wait a few minutes',
    removed: 'You were removed from the room',
    ended: 'The meeting has ended',
    lost: 'The connection was down too long: you left the room',
    failed: 'Cannot reach LongTalk: check the network and try again',
  },
  connecting: 'Connecting…',
  roomName: (roomName: string | null, createdBy: string | null) =>
    roomName ?? (createdBy ? `${createdBy}’s room` : 'the room'),
  confirm: {
    title: 'Confirm',
    question: (ownerName: string, roomName: string) =>
      `The pairing code is from ${ownerName}. Join “${roomName}”? Everyone in the room will see your screen.`,
    warning:
      'If someone you do not know asked you for this code on the phone or in a message, cancel.',
    join: 'Join',
    cancel: 'Cancel',
  },
  room: {
    joined: (roomName: string) => `In “${roomName}”`,
    owner: (ownerName: string) => `Shown in the room as ${ownerName}’s computer`,
    reconnecting: 'Connection lost, reconnecting…',
    share: 'Share my screen',
    sharing: 'Sharing your screen: everyone in the room can see it',
    notSharing: 'Not sharing the screen',
    pickHint: 'Turn it on to pick the screen to share (one of several monitors, too)',
    leave: 'Leave the room',
    switchScreen: 'Share another screen',
    whichScreen: 'Which screen are you sharing?',
    whichScreenHint:
      'Some of your screens are the same size: pick the one you share, so their pointer lands in the right place. It can’t be changed while someone controls this computer.',
    screenLabel: (n: number, width: number, height: number, primary: boolean) =>
      `Screen ${n} (${width}×${height}${primary ? ', main' : ''})`,
  },
  permissions: {
    title: 'System permissions for remote control',
    intro: 'Allow these in the system settings first, so that a control request can work here.',
    screen: 'Screen Recording: lets the room see your screen',
    accessibility:
      'Accessibility: lets their mouse and keyboard work (without it nothing happens at all)',
    inputMonitoring:
      'Input Monitoring (optional): press Esc three times to stop control; Stop works without it',
    open: 'Open settings',
    granted: 'Allowed',
    afterUpdate: 'After an update, the system may ask you to allow these again.',
    noX11:
      'This computer uses Wayland, where the agent can’t use the mouse and keyboard. For remote control, choose an “X11” or “Xorg” session at the login screen.',
  },
  shareProblems: {
    denied: 'The system does not allow capturing the screen: allow it in the system settings',
    unsupported: 'This computer cannot share its screen',
    failed: 'Sharing the screen failed: try again',
    full: 'The room already has as many shares as it allows',
    audioOnly: 'This month’s allowance is nearly used up: the room cannot share screens for now',
    fromTray: 'Turn on “Share my screen” in this window to pick the screen to share',
  },
  control: {
    asks: (name: string) => `${name} wants to control this computer`,
    inRoom: (room: string) => `In “${room}”`,
    nameNote: 'They chose this name themselves.',
    consequence:
      'If you allow it, they can do anything with your mouse and keyboard; everyone in the room sees your screen.',
    closesIn: (time: string) => `Declined automatically in ${time}`,
    allow10: 'Allow 10 minutes',
    allowUntilStop: 'Allow until I stop it',
    deny: 'Decline',
    mute: 'Take no requests for',
    muteFor: 'How long to take no requests',
    minutes: (n: number) => `${n} minutes`,
    reconfirm: (name: string) => `Keep letting ${name} control this computer?`,
    reconfirmNote:
      '“Allow until I stop it” asks again every hour. Without an answer, control ends.',
    keepGoing: 'Keep going',
    stop: 'Stop',
    controlling: (name: string) => `${name} is controlling this computer`,
    pressed: (name: string, combo: string) => `${name} pressed ${combo}`,
    failed: 'That did not go through; press it again',
    allowPaste: 'Also let them paste text to this computer’s clipboard',
    allowPasteNote:
      'Only from them to you: your clipboard is never read. You can turn it off at any time.',
    pasteOn: 'They can paste text',
    pasteOff: 'Stop pasting',
    pasted: (name: string, chars: number) => `${name} put ${chars} characters on your clipboard`,
  },
}

export const dictionaries = { 'zh-TW': zhTW, en } as const

export type AgentLocale = keyof typeof dictionaries

export function pickLocale(language: string): AgentLocale {
  return language.toLowerCase().startsWith('zh') ? 'zh-TW' : 'en'
}

export const locale: AgentLocale = pickLocale(
  typeof navigator === 'undefined' ? 'zh-TW' : navigator.language,
)

export const text: AgentStrings = dictionaries[locale]
