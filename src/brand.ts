// The brand as files (e4-t19, DESIGN.md §7): the web app manifest and the icons, Open Graph image
// and meta tags that point at them. The name is English only, "LongTalk" (PRD §14): no Chinese
// name in the name, the logo, the icons, the manifest or the Open Graph title. Descriptions are
// interface text, Traditional Chinese like the rest.
//
// scripts/brand.ts writes public/manifest.webmanifest from `webManifest()` and renders the PNGs
// from the SVGs in docs/design/logo/ (`npm run brand`, DEPLOY.md §9); tests/shared/brand.test.ts
// checks that what is committed in public/ and index.html matches this file.
// The static page and the manifest speak Chinese, the default locale (G1: the app switches at run
// time, these files do not)
import { zhTW as strings } from './i18n/zh-TW.ts'
import { palette } from './styles/tokens.ts'

/** The production site: Open Graph needs an absolute image URL (previews point here too) */
export const SITE_URL = 'https://longtalk.genelee-pro.workers.dev'

/** The logo's English line (DESIGN.md §7), on the Open Graph image */
export const BRAND_TAGLINE = 'The meeting room that never cuts out'

/** For search results, link previews and the installed app */
export const BRAND_DESCRIPTION = `${strings.tagline}。${strings.home.intro}`

/** Every icon file, where it comes from and how big it is (scripts/brand.ts renders them) */
export const ICONS: readonly { file: string; from: string; size: number; square?: boolean }[] = [
  // The browser tab: the rounded square of favicon.svg; .ico for browsers that ask for it
  { file: 'favicon.ico', from: 'favicon.svg', size: 32 },
  { file: 'icons/favicon-32.png', from: 'favicon.svg', size: 32 },
  // iOS home screen: favicon.svg's square without its rounded corners (iOS rounds them itself)
  { file: 'apple-touch-icon.png', from: 'favicon.svg', size: 180, square: true },
  // The installed app (manifest): "any" keeps the rounded square, "maskable" fills the square
  { file: 'icons/icon-192.png', from: 'favicon.svg', size: 192 },
  { file: 'icons/icon-512.png', from: 'favicon.svg', size: 512 },
  { file: 'icons/icon-maskable-192.png', from: 'icon-maskable.svg', size: 192 },
  { file: 'icons/icon-maskable-512.png', from: 'icon-maskable.svg', size: 512 },
]

export const OG_IMAGE = { file: 'og-image.png', width: 1200, height: 630 } as const

/**
 * Window and splash colours: the room is always dark (DESIGN.md §1.2) and an installed LongTalk
 * is mostly a room, so the app uses the dark background
 */
export const APP_COLORS = { theme: palette.dark.bg, background: palette.dark.bg } as const

/** The browser bar follows the page: the home page's background in each scheme */
export const THEME_COLORS = { light: palette.light.bg, dark: palette.dark.bg } as const

/** public/manifest.webmanifest (no service worker yet: installable where the browser allows) */
export function webManifest() {
  const icon = (file: string, size: number, purpose: 'any' | 'maskable') => ({
    src: `/${file}`,
    sizes: `${size}x${size}`,
    type: 'image/png',
    purpose,
  })
  return {
    id: '/',
    name: strings.appName,
    short_name: strings.appName,
    description: BRAND_DESCRIPTION,
    lang: 'zh-Hant-TW',
    dir: 'ltr',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: APP_COLORS.theme,
    background_color: APP_COLORS.background,
    icons: [
      { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      icon('icons/icon-192.png', 192, 'any'),
      icon('icons/icon-512.png', 512, 'any'),
      icon('icons/icon-maskable-192.png', 192, 'maskable'),
      icon('icons/icon-maskable-512.png', 512, 'maskable'),
    ],
  }
}
