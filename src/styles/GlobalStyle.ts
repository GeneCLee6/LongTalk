import { createGlobalStyle } from 'styled-components'
import { color, font, fontSize, schemeVars } from './tokens.ts'

// Colour variables for both schemes (tokens.ts), the base type and the reduced-motion switch.
// Scheme: the system's by default; data-theme on any element forces its subtree.
export const GlobalStyle = createGlobalStyle`
  :root {
    --lt-font-ui: ${font.ui};
    ${schemeVars('light')}
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      ${schemeVars('dark')}
      color-scheme: dark;
    }
  }
  [data-theme='light'] {
    ${schemeVars('light')}
    color-scheme: light;
  }
  [data-theme='dark'] {
    ${schemeVars('dark')}
    color-scheme: dark;
  }

  *, *::before, *::after {
    box-sizing: border-box;
  }

  body {
    margin: 0;
    font-family: ${font.current};
    font-size: ${fontSize.base};
    line-height: 1.5;
    background: ${color.bg};
    color: ${color.fg};
    -webkit-font-smoothing: antialiased;
  }
  /* English (G1, e4-t15): <html lang="en"> */
  html:lang(en) {
    --lt-font-ui: ${font.uiLatin};
  }

  button, input, select, textarea {
    font: inherit;
  }

  :focus-visible {
    outline: 2px solid ${color.focus};
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      transition-duration: 0.01ms !important;
    }
  }

  /* 省電模式 (e6-t05) turns motion off the same way */
  html[data-motion='off'] *, html[data-motion='off'] *::before, html[data-motion='off'] *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
`
