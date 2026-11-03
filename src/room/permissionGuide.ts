import type { Strings } from '../strings.ts'

// The permission tutorial (G1, e4-t09): when the browser blocks the microphone or camera, the
// pre-join screen shows how to allow it in *this* browser. Which steps to show is the one place
// the user agent is read: it only picks help text, never whether a feature is offered (that stays
// feature detection, capabilities.ts). The guess can be wrong, so the screen lets the person pick
// another browser's steps.

export type GuideId =
  'chrome' | 'edge' | 'firefox' | 'safariMac' | 'iosSafari' | 'iosOther' | 'android' | 'other'

/** In the order the browser menu lists them */
export const GUIDE_IDS: readonly GuideId[] = [
  'chrome',
  'edge',
  'firefox',
  'safariMac',
  'iosSafari',
  'iosOther',
  'android',
  'other',
]

/** The operating system's own switch for the browser (macOS, Windows, iOS, Android) */
export type SystemId = keyof Strings['permissionGuide']['system']

export type StepKey = keyof Strings['permissionGuide']['steps']

/** The icon beside a step (drawn in PermissionGuide.tsx) */
export type StepIcon =
  'siteInfo' | 'lock' | 'toggle' | 'blocked' | 'menu' | 'textSize' | 'settings' | 'retry'

export interface GuideStep {
  icon: StepIcon
  text: StepKey
}

const retry: GuideStep = { icon: 'retry', text: 'retry' }

export const GUIDES: Record<GuideId, readonly GuideStep[]> = {
  chrome: [
    { icon: 'siteInfo', text: 'chromeSite' },
    { icon: 'toggle', text: 'chromeAllow' },
    retry,
  ],
  edge: [{ icon: 'lock', text: 'edgeSite' }, { icon: 'toggle', text: 'allowBoth' }, retry],
  firefox: [
    { icon: 'blocked', text: 'firefoxIcon' },
    { icon: 'toggle', text: 'firefoxClear' },
    { icon: 'retry', text: 'firefoxRetry' },
  ],
  safariMac: [{ icon: 'menu', text: 'safariMenu' }, { icon: 'toggle', text: 'allowBoth' }, retry],
  iosSafari: [
    { icon: 'textSize', text: 'iosSafariSize' },
    { icon: 'toggle', text: 'allowBoth' },
    retry,
  ],
  iosOther: [
    { icon: 'settings', text: 'iosSettings' },
    { icon: 'toggle', text: 'iosToggle' },
    retry,
  ],
  android: [
    { icon: 'siteInfo', text: 'androidSite' },
    { icon: 'toggle', text: 'allowBoth' },
    retry,
  ],
  other: [{ icon: 'lock', text: 'otherSite' }, { icon: 'toggle', text: 'allowBoth' }, retry],
}

export interface BrowserHints {
  userAgent: string
  /** iPadOS says "Macintosh"; only its touch screen gives it away */
  maxTouchPoints?: number
}

const isIos = ({ userAgent, maxTouchPoints = 0 }: BrowserHints) =>
  /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)

/** Which browser's steps to show first */
export function detectGuide(hints: BrowserHints): GuideId {
  const ua = hints.userAgent
  if (isIos(hints)) return /CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua) ? 'iosOther' : 'iosSafari'
  if (/Android/.test(ua)) return 'android'
  if (/Edg\//.test(ua)) return 'edge'
  if (/Firefox\//.test(ua)) return 'firefox'
  if (/Chrome\/|Chromium\//.test(ua)) return 'chrome'
  if (/Safari\//.test(ua) && /Macintosh/.test(ua)) return 'safariMac'
  return 'other'
}

/** The operating system whose own privacy switch may block the browser; null when unknown */
export function detectSystem(hints: BrowserHints): SystemId | null {
  const ua = hints.userAgent
  if (isIos(hints)) return 'ios'
  if (/Android/.test(ua)) return 'android'
  if (/Macintosh|Mac OS X/.test(ua)) return 'mac'
  if (/Windows/.test(ua)) return 'windows'
  return null
}

export function browserHints(): BrowserHints {
  if (typeof navigator === 'undefined') return { userAgent: '' }
  return { userAgent: navigator.userAgent ?? '', maxTouchPoints: navigator.maxTouchPoints ?? 0 }
}
