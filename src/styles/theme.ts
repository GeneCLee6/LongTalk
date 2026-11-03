import { useSyncExternalStore } from 'react'
import type { Scheme } from './tokens.ts'

/**
 * The light / dark choice (G5, AC-4.8): follow the system (the default) or force one. Pages
 * follow it; the room stays dark whatever is chosen (DESIGN.md §1.2), with its own data-theme.
 * Forcing sets data-theme on <html>, which GlobalStyle's [data-theme] rules switch; remembered in
 * localStorage, applied before the first render (main.tsx) so a page never flashes the other one.
 */
export type ThemeChoice = 'system' | Scheme

export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark']

const THEME_KEY = 'longtalk.theme'
const listeners = new Set<() => void>()

export const isThemeChoice = (value: unknown): value is ThemeChoice =>
  value === 'system' || value === 'light' || value === 'dark'

function readSaved(): ThemeChoice {
  try {
    const saved = globalThis.localStorage?.getItem(THEME_KEY)
    return isThemeChoice(saved) ? saved : 'system'
  } catch {
    return 'system'
  }
}

let choice: ThemeChoice = readSaved()

/** Puts the choice on <html>: data-theme for a forced scheme, nothing for the system's */
export function applyTheme(which: ThemeChoice = choice): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (which === 'system') delete root.dataset.theme
  else root.dataset.theme = which
}

export const getTheme = (): ThemeChoice => choice

export function setTheme(next: ThemeChoice, remember = true): void {
  if (remember) {
    try {
      if (next === 'system') globalThis.localStorage?.removeItem(THEME_KEY)
      else globalThis.localStorage?.setItem(THEME_KEY, next)
    } catch {
      // Storage blocked: the choice lasts for this page only
    }
  }
  choice = next
  applyTheme(next)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The current choice; the component re-renders when it changes */
export function useTheme(): ThemeChoice {
  return useSyncExternalStore(subscribe, getTheme, getTheme)
}
