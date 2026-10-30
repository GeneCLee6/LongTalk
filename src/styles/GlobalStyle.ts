import { createGlobalStyle } from 'styled-components'
import { color, font, fontSize, schemeVars } from './tokens.ts'

// Colour variables for both schemes (tokens.ts), the base type and the reduced-motion switch.
// Scheme: the system's by default; data-theme on any element forces its subtree.
export const GlobalStyle = createGlobalStyle`
  :root {
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
    font-family: ${font.ui};
    font-size: ${fontSize.base};
    line-height: 1.5;
    background: ${color.bg};
    color: ${color.fg};
    -webkit-font-smoothing: antialiased;
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
`
