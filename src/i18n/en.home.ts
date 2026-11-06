import type { HomeStrings } from './types.ts'

// What the home page needs of the English dictionary (J4, RULES.md §1); see zh-TW.home.ts.
export const enHome: HomeStrings = {
  appName: 'LongTalk',
  tagline: 'The meeting room that never cuts out',
  home: {
    intro:
      'Send a link and your friends are in with one click. No app, no sign-up, no 40-minute limit.',
    createRoom: 'Start a room',
    creatingRoom: 'Starting…',
    createRoomFailed: 'Couldn’t start a room. Please try again.',
    verifying: 'Checking…',
    createRoomVerifyFailed: 'The human check didn’t pass. Please try again.',
    createRoomRateLimited: (minutes: number) =>
      `Too many rooms from this network. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    createRoomBlocked: 'This network can’t start or join rooms right now.',
    joinLabel: 'Room link or code',
    joinPlaceholder: 'Paste a link or type a code',
    join: 'Join',
    joinInvalid: 'That doesn’t look like a room. Paste the whole link or the 10-character code.',
    perks: [
      {
        title: 'No time limit',
        body: 'Talk till sunrise without being cut off. A room closes only after the last person leaves.',
      },
      {
        title: 'Nothing to install',
        body: 'Open it in a browser and go, on your phone too. No account needed.',
      },
      {
        title: 'Screen sharing and drawing',
        body: 'Share your whole screen, a window or a tab; soon you’ll be able to draw on it too.',
      },
    ],
  },
  language: {
    label: 'Language',
    section: 'Language',
    names: { 'zh-TW': '繁體中文', en: 'English' },
  },
  theme: {
    label: 'Appearance',
    names: { system: 'Match system', light: 'Light', dark: 'Dark' },
  },
  loadFailed: {
    title: 'Couldn’t load. Please reload',
    body: 'The connection may have dropped, or LongTalk was just updated. Reload to carry on.',
    reload: 'Reload',
  },
  pwa: {
    installLabel: 'Install app',
    installTitle: 'Install LongTalk',
    installBody: 'Put it on your computer or phone and start a meeting in one tap next time.',
    install: 'Install',
    installDismiss: 'No thanks',
    iosTitle: 'Add LongTalk to your Home Screen',
    iosBody: 'In Safari, tap Share, then “Add to Home Screen” to open it like an app next time.',
    iosDismiss: 'Got it',
    updateLabel: 'New version',
    update: 'A new version is ready. Reload to use it.',
    updateRoom:
      'A new version is ready. Reloading brings you straight back to this meeting, or it can wait until the meeting ends.',
    updateReload: 'Reload',
    updateLater: 'Later',
    offlineTitle: 'You’re offline',
    offlineHome: 'You’re offline. Connect to the internet to start or join a meeting.',
    offlineRoom:
      'Joining a meeting needs the internet. LongTalk will try again once you’re back online.',
  },
  privacy: {
    link: 'Privacy policy',
    linkNewTab: 'Privacy policy (opens in a new tab)',
    loading: 'Loading…',
  },
  account: {
    homeLink: 'Sign in',
    homeLinkSignedIn: 'My account',
  },
  record: {
    leftover: (when: string) => `There’s a recording that wasn’t saved (started ${when}).`,
    leftoverDownload: 'Download the unfinished recording',
    leftoverDelete: 'Delete',
    leftoverDownloaded: 'Downloaded the unfinished recording',
    leftoverDeleted: 'Deleted the unfinished recording',
  },
}
