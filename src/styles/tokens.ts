// The only place colours live (CLAUDE.md rule 5), from docs/DESIGN.md §2–3. Components use
// `color.*`, which are CSS variables; GlobalStyle fills them from `palette` for the light or dark
// scheme. Pages follow the system, the room is dark (DESIGN.md §1.2): any element with
// data-theme="light" | "dark" switches its subtree.

export type Scheme = 'light' | 'dark'

const light = {
  bg: '#F6F7F9',
  surface: '#FFFFFF',
  surface2: '#EEF1F5',
  fg: '#0F172A',
  muted: '#5B6474',
  line: '#D9DEE7',
  primary: '#0E7490',
  primarySoft: '#DFF5F7',
  onPrimary: '#FFFFFF',
  speaking: '#22C55E',
  danger: '#DC2626',
  onDanger: '#FFFFFF',
  warn: '#D97706',
  // Text on a `warn` background (the raised-hand badge, G3)
  onWarn: '#1F1300',
  tileFrom: '#1E293B',
  tileTo: '#0F172A',
  // Controls laid over video (pre-join preview, later the tiles)
  overlay: 'rgba(11, 18, 32, 0.72)',
  // Hover and pressed overlays, menu shadow, focus ring
  hover: 'rgba(15, 23, 42, 0.06)',
  pressed: 'rgba(15, 23, 42, 0.12)',
  shadow: 'rgba(15, 23, 42, 0.16)',
  focus: '#0E7490',
}

export type ColorToken = keyof typeof light

const dark: Record<ColorToken, string> = {
  bg: '#0B1220',
  surface: '#111A2E',
  surface2: '#18233B',
  fg: '#E6EAF2',
  muted: '#9AA6BC',
  line: '#263350',
  primary: '#2DD4BF',
  primarySoft: '#153B43',
  onPrimary: '#06231F',
  speaking: '#4ADE80',
  danger: '#F87171',
  onDanger: '#1F0A0A',
  warn: '#FBBF24',
  onWarn: '#1F1300',
  tileFrom: '#1E293B',
  tileTo: '#0F172A',
  overlay: 'rgba(11, 18, 32, 0.72)',
  hover: 'rgba(230, 234, 242, 0.08)',
  pressed: 'rgba(230, 234, 242, 0.16)',
  shadow: 'rgba(0, 0, 0, 0.5)',
  focus: '#2DD4BF',
}

export const palette: Record<Scheme, Record<ColorToken, string>> = { light, dark }

const tokens = Object.keys(light) as ColorToken[]
const cssVar = (token: ColorToken) => `--lt-${token}`

/** The custom-property declarations for one scheme, for GlobalStyle */
export function schemeVars(scheme: Scheme): string {
  return tokens.map((token) => `${cssVar(token)}: ${palette[scheme][token]};`).join('\n')
}

const vars = Object.fromEntries(tokens.map((token) => [token, `var(${cssVar(token)})`])) as Record<
  ColorToken,
  string
>

/** `color.bg` → `var(--lt-bg)`: use these in styled-components, never colour literals */
export const color = vars

export const font = {
  ui: "'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', system-ui, -apple-system, 'Segoe UI', sans-serif",
  // The English interface (G1): a Latin font first, so ’ and “ ” are not the CJK font's
  // full-width ones; Chinese names still fall through to the CJK fonts
  uiLatin:
    "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', sans-serif",
  // What components use: the stack for the language shown (GlobalStyle sets the variable)
  current: 'var(--lt-font-ui)',
  // The wordmark only (DESIGN.md §7)
  brand: "'Inter', system-ui, sans-serif",
  // Password fields: a Latin font first, so the mask dot is not the CJK font's full-width one
  secret: "'Segoe UI', Roboto, 'Helvetica Neue', Arial, system-ui, sans-serif",
  mono: "ui-monospace, 'Cascadia Code', 'SF Mono', Menlo, Consolas, monospace",
} as const

export const fontSize = {
  base: '16px',
  small: '14px',
  nameplate: '13px',
  toolbarLabel: '12px',
  badge: '11px',
  title: '28px',
  titleWide: '40px',
} as const

export const radius = {
  tile: '12px',
  nameplate: '8px',
  button: '10px',
  panel: '16px',
  pill: '999px',
} as const

/**
 * A camera-off tile's initial sits on a colour picked from the member's name (DESIGN.md §5, the
 * mockup's avatars). Tiles are dark in both schemes, so these are fixed, not CSS variables; the
 * white initial is ≥ 4.5:1 on every one.
 */
export const avatar = {
  text: '#FFFFFF',
  backgrounds: [
    '#1D4ED8',
    '#7C3AED',
    '#0E7490',
    '#B45309',
    '#BE185D',
    '#475569',
    '#047857',
    '#9333EA',
  ],
} as const

/** The same name always gets the same colour (FNV-1a over the code points) */
export function avatarColor(name: string): string {
  let hash = 0x811c9dc5
  for (const char of name) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  // FNV's low bits are weak: mix the high ones in before taking a few (murmur3's finaliser)
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b)
  hash ^= hash >>> 13
  const { backgrounds } = avatar
  return backgrounds[(hash >>> 0) % backgrounds.length]
}

/** Spacing in multiples of 4 px: space(2) → '8px' */
export const space = (steps: number): string => `${steps * 4}px`

export const size = {
  toolbarButton: '44px',
  toolbarButtonTouch: '48px',
  sidePanel: '320px',
} as const

export const breakpoint = {
  // At or below this width the layout is the phone layout (DESIGN.md §4)
  phone: '640px',
  // A landscape screen at or below this height is a phone held sideways (e4-t07)
  phoneLandscape: '500px',
} as const

/**
 * Media queries, shared by CSS (`@media ${media.phone}`) and JS (matchMedia, layoutContext.ts)
 * so the two never disagree about whether this is a phone
 */
export const media = {
  // A phone held upright (or a desktop window as narrow): the paged gallery
  phonePortrait: `(max-width: ${breakpoint.phone}) and (orientation: portrait)`,
  // A phone held sideways (or a window as short): the speaker layout
  phoneLandscape: `(max-height: ${breakpoint.phoneLandscape}) and (orientation: landscape)`,
  // Either: compact chrome (icon-only toolbar, bottom sheets)
  phone: `(max-width: ${breakpoint.phone}), (max-height: ${breakpoint.phoneLandscape}) and (orientation: landscape)`,
  // A mouse or trackpad: the pager's previous / next buttons (touch screens swipe)
  finePointer: '(hover: hover) and (pointer: fine)',
  // A touch screen is the main input (phones, tablets without a mouse): an on-screen keyboard,
  // where chat's Enter is a new line and only the send button sends
  touchPrimary: '(hover: none) and (pointer: coarse)',
  reducedMotion: '(prefers-reduced-motion: reduce)',
} as const

export const motion = {
  fast: '120ms',
  base: '200ms',
  toastMs: 4000,
} as const

/** Behind a thumbnail made from a transparent image (a JPEG has no transparency, I5) */
export const thumbnailBackdrop = '#ffffff'

export const layer = {
  overlay: 10,
  menu: 20,
  // Bottom sheets and full-screen drawers (phones), above menus, below toasts
  drawer: 25,
  // The image viewer (I5), opened from the chat drawer
  lightbox: 28,
  toast: 30,
} as const
