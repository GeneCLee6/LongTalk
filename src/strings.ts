// The only place interface text lives (CLAUDE.md rule 5). Traditional Chinese (Taiwan); the
// product name is English only. i18n (zh-TW / en) arrives in G1 (e4-t15), which turns this object
// into one of two dictionaries with the same shape.
export const strings = {
  appName: 'LongTalk',
  tagline: '一間開著就不會斷的會議室',
  home: {
    createRoom: '建立會議室',
    creatingRoom: '建立中…',
    createRoomFailed: '建立會議室失敗，請再試一次。',
  },
  room: {
    title: (roomId: string) => `會議室 ${roomId}`,
    connecting: '連線中…',
    memberCount: (count: number) => `目前 ${count} 人在線`,
    notFound: '找不到這間會議室，請確認連結是否正確。',
    full: '這間會議室已經滿了。',
    outdated: 'LongTalk 已經更新，請重新整理頁面。',
    closed: '連線中斷了，請重新整理頁面。',
    backHome: '回首頁',
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
    more: '更多',
    leave: '離開',
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
    mutedByHost: '你被主持人靜音',
  },
  errors: {
    sfuNotConfigured: '媒體伺服器尚未設定（缺少 Realtime 的 App ID 或 App Secret）。',
    sfu: '媒體伺服器回應錯誤。',
    trackNotFound: '找不到對方的軌，可能已經停止分享。',
    permissionDenied: '瀏覽器沒有麥克風或鏡頭權限。',
    unknown: '發生未預期的錯誤。',
  },
  // The two-browser Realtime spike (A2, /dev/realtime). Removed once the room page does this.
  spike: {
    title: 'Realtime 互通測試',
    intro:
      '兩台裝置都打開這一頁。各自按「開始發布」，把自己的 session id 傳給對方，貼到下面再按「接收」。',
    publish: '開始發布（麥克風＋鏡頭）',
    publishing: '發布中…',
    sessionId: '我的 session id',
    remoteSession: '對方的 session id',
    remoteSessionPlaceholder: '貼上對方的 session id',
    pull: '接收',
    localVideo: '我的畫面',
    remoteVideo: '對方的畫面',
    tracks: (names: string) => `已發布的軌：${names}`,
    stats: (rtt: string, relay: boolean) => `RTT ${rtt} ms・${relay ? '經 TURN' : '直連'}`,
    state: (state: string) => `狀態：${state}`,
    hangUp: '結束',
  },
} as const
