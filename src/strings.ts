// The only place interface text lives (CLAUDE.md rule 5). Traditional Chinese (Taiwan); the
// product name is English only. i18n (zh-TW / en) arrives in G1 (e4-t15), which turns this object
// into one of two dictionaries with the same shape.
export const strings = {
  appName: 'LongTalk',
  tagline: '開著就不會斷的會議室',
  home: {
    intro: '貼一個連結，朋友點了就進來。不用裝 App、不用註冊、沒有 40 分鐘限制。',
    createRoom: '開一間房',
    creatingRoom: '開房中…',
    createRoomFailed: '開房失敗，請再試一次。',
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
  prejoin: {
    title: '準備加入',
    roomCode: (roomId: string) => `會議室 ${roomId}`,
    memberCount: (count: number) => (count === 0 ? '目前還沒有人在裡面' : `目前 ${count} 人在裡面`),
    nameLabel: '你的名字',
    namePlaceholder: '別人會看到這個名字',
    join: '加入',
    joining: '加入中…',
    preview: '鏡頭預覽',
    mirrored: '鏡像預覽',
    camOffPreview: '鏡頭已關閉',
    opening: '正在開啟鏡頭與麥克風…',
    micLevel: '麥克風音量',
    micLabel: '麥克風',
    camLabel: '鏡頭',
    speakerLabel: '喇叭',
    micOn: '關閉麥克風',
    micOff: '開啟麥克風',
    camOn: '關閉鏡頭',
    camOff: '開啟鏡頭',
    deviceFallback: (kind: '麥克風' | '鏡頭' | '喇叭', n: number) => `${kind} ${n}`,
    noDevices: '沒有可用的裝置',
    joinState: (mic: boolean, cam: boolean) =>
      `進房後麥克風${mic ? '開' : '關'}、鏡頭${cam ? '開' : '關'}`,
    problems: {
      denied:
        '瀏覽器沒有麥克風或鏡頭的權限。點網址列旁的鎖頭圖示允許後按「重試」，或先不開裝置直接加入。',
      micNotFound: '找不到麥克風。',
      camNotFound: '找不到鏡頭。',
      inUse: '麥克風或鏡頭正被其他程式使用，或無法啟動。關掉那個程式後按「重試」。',
      unsupported: '這個瀏覽器不能使用麥克風與鏡頭（網頁需要 HTTPS）。仍然可以加入。',
      unknown: '無法開啟麥克風或鏡頭。',
    },
    loadFailed: '讀不到這間會議室的資訊，仍然可以試著加入。',
  },
  room: {
    title: (roomId: string) => `會議室 ${roomId}`,
    // The name a room has until the host renames it (e1-t05)
    defaultName: (creator: string) => `${creator} 的房間`,
    connecting: '連線中…',
    memberCount: (count: number) => `目前 ${count} 人在線`,
    members: '在房間裡的人',
    reconnecting: '重新連線中',
    notFound: '找不到這間會議室。請確認連結是否正確；房間沒有人超過 10 分鐘也會自動關閉。',
    youAreHost: '你現在是主持人',
    full: '這間會議室已經滿了。',
    outdated: 'LongTalk 已經更新，請重新整理頁面。',
    reconnectingSelf: '連線中斷，正在重新連線…',
    lost: '連不上會議室。請檢查網路，再按「重試」。',
    replaced: '你在另一個分頁加入了這間會議室，這個分頁已經離開。',
    backHome: '回首頁',
    grid: '會議室畫面',
    tileVideo: (name: string) => `${name} 的畫面`,
    camOff: '鏡頭沒開',
    mediaConnecting: '正在連接媒體伺服器…',
    mediaReconnecting: '正在恢復聲音與畫面…',
    mediaLost: '聲音與畫面中斷了。請檢查網路，再按「重試」。',
    relayed: '經由轉送伺服器',
    micMuted: '麥克風已關',
    speaking: '正在說話',
  },
  // The stage on phones (e4-t07): pages of four tiles, the speaker layout
  stage: {
    pager: '分頁畫面',
    hint: '左右滑動，或用方向鍵換頁',
    pages: '換頁',
    page: (page: number, pages: number) => `第 ${page} 頁，共 ${pages} 頁`,
    previous: '上一頁',
    next: '下一頁',
    strip: '其他參與者',
  },
  // The room's microphone, camera and speaker (e2-t05, e2-t06, e2-t09)
  devices: {
    controls: '會議控制',
    micMenu: '選擇麥克風與喇叭',
    camMenu: '選擇鏡頭',
    mic: '麥克風',
    cam: '鏡頭',
    speaker: '喇叭',
    problems: {
      denied: (kind: string) =>
        `瀏覽器沒有${kind}的權限。點網址列旁的鎖頭圖示，把${kind}改成「允許」後按「重試」。`,
      inUse: (kind: string) =>
        `${kind}正被其他程式使用，或無法啟動。關掉正在用${kind}的程式（例如另一個視訊軟體）後按「重試」。`,
      notFound: (kind: string) => `找不到${kind}。接上${kind}之後按「重試」。`,
      lost: (kind: string) =>
        `${kind}中斷了，也找不到其他${kind}。重新接上後會自動恢復，或按「重試」。`,
      unsupported: '這個瀏覽器不能使用麥克風與鏡頭（網頁需要 HTTPS）。你仍然看得到、聽得到其他人。',
      unknown: (kind: string) => `無法開啟${kind}，請按「重試」。`,
    },
    switched: (kind: string, label: string) =>
      label ? `${kind}中斷了，已改用「${label}」。` : `${kind}中斷了，已改用另一個${kind}。`,
    recovered: (kind: string, label: string) =>
      label ? `找到${kind}了，已改用「${label}」。` : `找到${kind}了。`,
    switchFailed: (kind: string) => `無法切換到那個${kind}，繼續使用原本的${kind}。`,
  },
  unsupported: {
    title: '這個瀏覽器不能視訊通話',
    body: '請改用最新版的 Chrome、Edge、Firefox 或 Safari 開啟這個連結。',
  },
  // The Realtime free-tier guard (e11-t13): the month's egress is past a threshold
  usage: {
    low: '本月的免費流量快用完了，視訊先改成低畫質。',
    audioOnly: '本月的免費流量快用完了，先暫停新的視訊，只保留聲音。',
    videoRefused: '本月的免費流量快用完了，你的鏡頭先不送出，大家仍然聽得到你。',
  },
  common: {
    close: '關閉',
    cancel: '取消',
    retry: '重試',
    copy: '複製',
    copied: '已複製',
    more: '更多',
    you: '你',
  },
  toolbar: {
    micOn: '靜音',
    micOff: '解除靜音',
    camOn: '關閉視訊',
    camOff: '開啟視訊',
    share: '分享螢幕',
    chat: '聊天',
    participants: '參與者',
    participantsCount: (count: number) => `參與者（${count} 人）`,
    // The chat button's accessible name with its unread badge (D3)
    chatUnread: (count: number) => (count > 0 ? `聊天（${count} 則未讀）` : '聊天'),
    more: '更多',
    leave: '離開',
    // Buttons whose feature lands in a later batch (reactions, E5)
    comingSoon: (feature: string) => `「${feature}」即將推出`,
  },
  // The participants panel and the host controls (F1: e1-t07, e1-t08)
  participants: {
    title: '參與者',
    close: '關閉參與者',
    // The side panel's switch between chat and participants (DESIGN.md mockup)
    tabs: '側欄內容',
    tabParticipants: (count: number) => `參與者 ${count}`,
    list: '參與者名單',
    host: '主持人',
    cohost: '共同主持人',
    you: '你',
    reconnecting: '重新連線中',
    sharing: '正在分享畫面',
    micOn: '麥克風開著',
    micOff: '麥克風已關',
    camOn: '鏡頭開著',
    camOff: '鏡頭沒開',
    // The per-person menu (only what the viewer's role may do; RoomDO checks again)
    actions: (name: string) => `對 ${name} 的動作`,
    mute: '靜音',
    camOffAction: '關閉鏡頭',
    stopShare: '停止分享',
    remove: '移出會議室',
    muteAll: '全員靜音',
    muteAllHint: '每個人都可以自己再打開麥克風',
    endMeeting: '結束會議',
    // Confirmations
    removeTitle: (name: string) => `把 ${name} 移出會議室？`,
    removeBody: (name: string) =>
      `${name} 會立即離開，而且 10 分鐘內不能用同一個瀏覽器再加入這間會議室。`,
    removeConfirm: '移出',
    endTitle: '結束會議？',
    endBody: '每個人都會離開，會議室也會立即關閉，聊天訊息一併刪除。',
    endConfirm: '結束會議',
    // What the actor sees after acting
    mutedAll: '已將所有人靜音',
    removed: (name: string) => `已將 ${name} 移出會議室`,
    forbidden: '你沒有權限做這件事。',
  },
  // What the person acted on sees (F1, AC-1.4): a toast that says who did what
  hostNotice: {
    // 「主持人 Gene」: who did it, with their role (participants.host / cohost)
    actor: (role: string, name: string) => `${role} ${name}`,
    muted: (actor: string) => `${actor} 將你靜音了。要說話時，請自己打開麥克風。`,
    mutedAll: (actor: string) => `${actor} 將所有人靜音了。要說話時，請自己打開麥克風。`,
    camOff: (actor: string) => `${actor} 關閉了你的鏡頭。要開鏡頭時，請自己再打開。`,
    shareStopped: (actor: string) => `${actor} 停止了你的分享畫面。`,
  },
  // Screen sharing (D1: e3-t01 – e3-t03, e3-t05)
  screenShare: {
    stop: '停止分享',
    // The bar the sharer sees above the stage (e3-t03)
    youAreSharing: '你正在分享畫面',
    youAreSharingHint: '其他人看得到你分享的畫面',
    // The tag on the share (DESIGN.md: 「<名字> 的畫面」) and the share's accessible name
    label: (name: string) => `${name} 的畫面`,
    region: (name: string) => `${name} 分享的畫面`,
    waiting: (name: string) => `${name} 開始分享畫面，馬上就來…`,
    // Taking the share over from someone (e3-t02)
    takeOverTitle: '接手分享？',
    takeOverBody: (name: string) =>
      `${name} 正在分享畫面。接手後，${name} 的分享會停止，改成分享你的畫面。`,
    takeOver: '接手分享',
    takenOver: (name: string) => `${name} 接手了分享，你的分享已停止。`,
    stopped: '你的分享已被停止。',
    started: (name: string) => `${name} 開始分享畫面`,
    problems: {
      denied:
        '系統不允許瀏覽器分享螢幕。Mac 請到「系統設定 › 隱私權與安全性 › 螢幕與系統錄音」允許這個瀏覽器，重新開啟瀏覽器後再試一次。',
      unsupported: '這個瀏覽器不能分享螢幕，請改用電腦上的 Chrome、Edge 或 Firefox。',
      failed: '無法分享這個畫面，請再試一次，或改選其他視窗或分頁。',
    },
    audioOnly: '本月的免費流量快用完了，先暫停螢幕分享，大家仍然聽得到你。',
    // The share's sound (e3-t04): the sharing bar's switch, labelled with what it does
    audioOn: '關閉分享音訊',
    audioOff: '開啟分享音訊',
    withAudioHint: '其他人看得到畫面、聽得到聲音；戴耳機可以避免回音',
    audioOffHint: '其他人看得到畫面，分享音訊已關閉',
    // Where the browser cannot share (e3-t10): the 更多 menu explains instead of a button
    unavailablePhone: '手機瀏覽器不能分享螢幕。要分享，請用電腦加入這間會議室。',
    unavailableBrowser: '這個瀏覽器不能分享螢幕。請改用電腦上的 Chrome、Edge 或 Firefox。',
  },
  // Room chat (D3: e5-t01, e5-t02)
  chat: {
    title: '聊天',
    close: '關閉聊天',
    messages: '聊天訊息',
    empty: '還沒有訊息。在這裡說的話，房間裡的每個人都看得到。',
    retention: '訊息只留在這場會議，房間關閉後就會刪除。',
    inputLabel: '輸入訊息',
    placeholder: '傳訊息給所有人…',
    hint: 'Enter 送出，Shift + Enter 換行',
    send: '送出',
    you: '你',
    // 「小潔 · 21:04」 above a message
    meta: (name: string, time: string) => `${name} · ${time}`,
    // What a screen reader hears before a message's text
    spoken: (name: string, time: string) => `${name}，${time}：`,
    remaining: (left: number) => (left >= 0 ? `還可以打 ${left} 個字` : `超過 ${-left} 個字`),
    tooLong: (max: number) => `訊息最多 ${max} 個字，請分成幾則傳。`,
    rateLimited: '你傳得太快了，請等幾秒再傳。',
    offline: '連線中斷，訊息還沒送出；連上後再按一次送出。',
    // The bubble that previews a new message while the panel is closed
    preview: '新訊息',
    previewOpen: (name: string) => `打開聊天，看 ${name} 的訊息`,
    openLink: (url: string) => `開啟連結 ${url}（新分頁）`,
  },
  // The owner's dashboard (e11-t03): /admin
  admin: {
    title: 'LongTalk 管理',
    lockedTitle: '管理頁',
    lockedBody: '這一頁只給 LongTalk 的擁有者。輸入管理密碼（Worker 的 ADMIN_TOKEN）才能查看。',
    tokenLabel: '管理密碼',
    unlock: '查看',
    unlocking: '讀取中…',
    wrongToken: '密碼不對。',
    notConfigured: '這個部署還沒設定 ADMIN_TOKEN，請照 DEPLOY.md 設定後再試。',
    loadFailed: '讀取失敗，請再試一次。',
    lock: '鎖上',
    refresh: '重新整理',
    updatedAt: (time: string) => `更新於 ${time}`,
    alertsTitle: '警示',
    noAlerts: '目前沒有警示。',
    alerts: {
      errors: '最近一兩個小時用戶端錯誤偏多，請看下方「最近的錯誤」。',
      joinFailures: '近 24 小時進房失敗比例偏高（20% 以上）。',
    },
    totalsTitle: '總覽',
    periods: { last24h: '近 24 小時', last7d: '近 7 天' },
    metrics: {
      joins: '進房',
      joinRate: '進房成功率',
      joinFailures: '進房失敗',
      reconnects: '重新連線',
      rebuilds: '媒體重建',
      relayRatio: '經由 TURN 轉送',
      errors: '用戶端錯誤',
      rating: '離開評分（平均）',
      ratingDistribution: '評分分布',
    },
    ratingAverage: (average: string, count: number) => `${average}（${count} 則）`,
    ratingScore: (score: number, count: number) => `${score} 分 ${count}`,
    reasons: {
      notFound: '找不到房間',
      full: '房間已滿',
      outdated: '版本過舊',
      lost: '連不上',
      replaced: '被另一分頁取代',
    },
    layers: { socket: '房間連線', media: '媒體連線' },
    none: '—',
    percent: (value: number) => `${Math.round(value * 100)}%`,
    daysTitle: '每日統計',
    day: '日期（UTC）',
    recentErrors: '最近的錯誤',
    noErrors: '沒有錯誤紀錄。',
    errorCount: (n: number) => `${n} 次`,
    usageTitle: '本月 Realtime 流量',
    usage: (month: string, gb: string, state: string) => `${month}：約 ${gb} GB（${state}）`,
    usageStates: { normal: '正常', low: '低畫質', audioOnly: '只剩音訊' },
    analyticsEngine: (on: boolean) =>
      on
        ? '事件也寫進 Workers Analytics Engine，可用 SQL API 細查（DEPLOY.md §8）。'
        : '這個部署沒有 Analytics Engine 綁定，只有上方的計數。',
    privacy: '統計只記事件種類與原因，不含名字、房號、聊天內容或 IP。',
  },
  // After pressing 「離開」, or when the room closed while we were away from it (e4-t18)
  left: {
    title: '你已經離開會議室',
    body: (room: string) => `你離開了「${room}」。`,
    closedTitle: '這間會議室已經關閉',
    closedBody: '房間沒有人超過 10 分鐘就會自動關閉。要繼續聊，回首頁開一間新的房。',
    // The host ended the meeting (F1)
    endedTitle: '主持人已結束會議',
    endedBody: (room: string) => `「${room}」已經結束，會議室也關閉了。`,
    // The host removed us, or this browser is still banned (F1)
    removedTitle: '你已被移出會議室',
    removedBody: (room: string) =>
      `主持人把你移出了「${room}」。10 分鐘內不能用這個瀏覽器再加入這間會議室。`,
    question: '這次通話的品質如何？',
    scores: { 1: '很差', 2: '不太好', 3: '普通', 4: '不錯', 5: '很好' },
    scoreLabel: (score: number, label: string) => `${score} 分：${label}`,
    thanks: '謝謝你的回饋！',
    privacy: '只記分數，不記你的名字或這間會議室。',
    rejoin: '重新加入',
    home: '回首頁',
  },
  // A part of the app that could not be loaded (e4-t20): a network blip, or a new deployment
  // replaced the files this page was built with
  loadFailed: {
    title: '載入失敗，請重新整理',
    body: '可能是網路中斷，或 LongTalk 剛更新。重新整理後就能繼續。',
    reload: '重新整理',
  },
  // The top bar (e4-t06): room name, elapsed time, copy link
  topBar: {
    label: '會議室資訊',
    elapsed: '會議時間',
    copyLink: '複製連結',
    copied: '已複製會議室連結，貼給朋友就能加入',
    copyFailed: (url: string) => `無法自動複製，請手動複製這個連結：${url}`,
  },
  // The room link, renaming (e1-t05)
  share: {
    action: '分享連結…',
    text: '來 LongTalk 一起聊：',
  },
  rename: {
    room: '重新命名會議室',
    roomLabel: '會議室名稱',
    self: '修改我的名字',
    selfLabel: '你的名字',
    save: '儲存',
    empty: '名字不能空白。',
    tooLong: (max: number) => `最多 ${max} 個字。`,
  },
  connection: {
    connecting: '連線中…',
    connected: '已連線',
    reconnecting: '重新連線中…',
    failed: '連線失敗',
  },
  toast: {
    region: '通知',
    joined: (name: string) => `${name} 加入了`,
    left: (name: string) => `${name} 離開了`,
  },
  errors: {
    sfuNotConfigured: '媒體伺服器尚未設定（缺少 Realtime 的 App ID 或 App Secret）。',
    sfu: '媒體伺服器回應錯誤，聲音與畫面可能送不出去。',
    sfuUnauthorized: '媒體伺服器不認得這個分頁，請重新整理頁面。',
    trackNotFound: '找不到對方的軌，可能已經停止分享。',
    permissionDenied: '瀏覽器沒有麥克風或鏡頭權限。',
    unknown: '發生未預期的錯誤。',
  },
} as const
