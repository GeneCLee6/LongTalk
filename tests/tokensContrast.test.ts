import { describe, expect, it } from 'vitest'
import { avatar, palette, type ColorToken, type Scheme } from '../src/styles/tokens.ts'

// G5 (e4-t14; DESIGN.md §2): every text colour the components use on every background it sits
// on, in both schemes, meets WCAG AA (4.5:1 for text, 3:1 for icons and large text). The room
// is always dark, so colours only used there are checked in the dark scheme only.

function luminance(hex: string): number {
  const value = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => {
    const channel = parseInt(value.slice(i, i + 2), 16) / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

type Pair = [fg: ColorToken, bg: ColorToken, min: number]

/** On the pages (both schemes) */
const pages: Pair[] = [
  ['fg', 'bg', 4.5],
  ['fg', 'surface', 4.5],
  ['fg', 'surface2', 4.5],
  ['muted', 'bg', 4.5],
  ['muted', 'surface', 4.5],
  ['muted', 'surface2', 4.5],
  ['primary', 'bg', 4.5],
  ['primary', 'surface', 4.5],
  ['primary', 'primarySoft', 4.5],
  ['onPrimary', 'primary', 4.5],
  ['danger', 'surface', 4.5],
  ['danger', 'bg', 4.5],
  ['onDanger', 'danger', 4.5],
  ['onWarn', 'warn', 4.5],
  ['fg', 'primarySoft', 4.5],
  // Icons, outlines and the focus ring
  ['warn', 'surface', 3],
  ['focus', 'bg', 3],
  ['focus', 'surface', 3],
]

/** In the room only (always dark): amber and green text, the speaking outline */
const room: Pair[] = [
  ['warn', 'bg', 4.5],
  ['warn', 'surface', 4.5],
  ['warn', 'surface2', 4.5],
  ['speaking', 'tileTo', 3],
  ['fg', 'tileFrom', 4.5],
]

describe('colour tokens meet WCAG AA', () => {
  for (const scheme of ['light', 'dark'] as Scheme[]) {
    const checks = scheme === 'dark' ? [...pages, ...room] : pages
    for (const [fg, bg, min] of checks) {
      it(`${scheme}: ${fg} on ${bg} ≥ ${min}:1`, () => {
        expect(contrast(palette[scheme][fg], palette[scheme][bg])).toBeGreaterThanOrEqual(min)
      })
    }
  }

  it('the avatar initial is ≥ 4.5:1 on every avatar colour', () => {
    for (const background of avatar.backgrounds) {
      expect(contrast(avatar.text, background)).toBeGreaterThanOrEqual(4.5)
    }
  })
})
