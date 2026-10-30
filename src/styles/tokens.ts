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
  tileFrom: '#1E293B',
  tileTo: '#0F172A',
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
  tileFrom: '#1E293B',
  tileTo: '#0F172A',
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
export const color = {
  ...vars,
  // A1 names, kept so the home page keeps building until A4 (e4-t02) restyles it
  brand: vars.primary,
  text: vars.fg,
  textMuted: vars.muted,
} as const

export const font = {
  ui: "'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', system-ui, -apple-system, 'Segoe UI', sans-serif",
  // The wordmark only (DESIGN.md §7)
  brand: "'Inter', system-ui, sans-serif",
  mono: "ui-monospace, 'Cascadia Code', 'SF Mono', Menlo, Consolas, monospace",
} as const

export const fontSize = {
  base: '16px',
  small: '14px',
  nameplate: '13px',
  toolbarLabel: '12px',
  title: '28px',
  titleWide: '40px',
} as const

export const radius = {
  tile: '12px',
  button: '10px',
  panel: '16px',
  pill: '999px',
} as const

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
} as const

export const motion = {
  fast: '120ms',
  base: '200ms',
  toastMs: 4000,
} as const

export const layer = {
  menu: 20,
  toast: 30,
} as const
