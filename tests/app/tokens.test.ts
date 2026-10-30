import { describe, expect, it } from 'vitest'
import { color, palette, schemeVars } from '../../src/styles/tokens.ts'

const sources = import.meta.glob<string>('../../src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
})

describe('design tokens', () => {
  it('defines every colour for both schemes', () => {
    expect(Object.keys(palette.dark).sort()).toEqual(Object.keys(palette.light).sort())
  })

  it('uses the DESIGN.md brand colours', () => {
    expect(palette.light.primary).toBe('#0E7490')
    expect(palette.dark.primary).toBe('#2DD4BF')
    expect(palette.dark.bg).toBe('#0B1220')
  })

  it('exposes colours as CSS variables that GlobalStyle defines', () => {
    expect(color.bg).toBe('var(--lt-bg)')
    expect(schemeVars('dark')).toContain('--lt-bg: #0B1220;')
  })

  // CLAUDE.md rule 5 until a lint rule does it (AC-4.8): colour literals only in tokens.ts
  it('keeps colour literals out of every other source file', () => {
    const offenders = Object.entries(sources)
      .filter(([file]) => !file.endsWith('src/styles/tokens.ts'))
      .filter(([, text]) => /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(text))
      .map(([file]) => file)
    expect(Object.keys(sources).length).toBeGreaterThan(5)
    expect(offenders).toEqual([])
  })
})
