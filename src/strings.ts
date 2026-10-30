// The only place interface text lives (CLAUDE.md rule 5). A2 (e4-t01) adds the skeleton for the
// whole app; i18n (zh-TW / en) arrives in G1 (e4-t15).
export const strings = {
  appName: 'LongTalk',
  tagline: '一間開著就不會斷的會議室',
  home: {
    comingSoon: '施工中：會議室即將開放。',
  },
  room: {
    title: (roomId: string) => `會議室 ${roomId}`,
    comingSoon: '會議室還在施工中。',
  },
} as const
