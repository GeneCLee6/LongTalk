// Colours come only from src/styles/tokens.ts (CLAUDE.md rule 5). The agent has no
// styled-components (its CSP allows no inline <style>): the palette's CSS variables are set on
// <html> through the CSSOM, which the CSP allows, and agent.css and inline styles use `color.*`.
import { font, palette, type ColorToken, type Scheme } from '../../../src/styles/tokens.ts'
import type { AgentLocale } from './i18n.ts'

function apply(scheme: Scheme): void {
  const root = document.documentElement
  for (const [token, value] of Object.entries(palette[scheme]) as [ColorToken, string][]) {
    root.style.setProperty(`--lt-${token}`, value)
  }
  root.style.colorScheme = scheme
}

/** Follows the system's light or dark scheme; the font stack for the language shown */
export function applyTheme(locale: AgentLocale): void {
  document.documentElement.style.setProperty(
    '--lt-font-ui',
    locale === 'en' ? font.uiLatin : font.ui,
  )
  document.documentElement.lang = locale === 'en' ? 'en' : 'zh-Hant-TW'
  const dark = window.matchMedia('(prefers-color-scheme: dark)')
  apply(dark.matches ? 'dark' : 'light')
  dark.addEventListener('change', (event) => apply(event.matches ? 'dark' : 'light'))
}
