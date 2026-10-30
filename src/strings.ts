// The only place interface text lives (CLAUDE.md rule 5). A2 (e4-t01) adds the skeleton for the
// whole app; i18n (zh-TW / en) arrives in G1 (e4-t15).
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
} as const
