import styled from 'styled-components'
import { strings } from '../strings.ts'
import { color, font } from '../styles/tokens.ts'

// The mark from docs/design/logo/logo-mark.svg (two speech bubbles woven into ∞), drawn in the
// primary token so it follows the light and dark schemes. Brand finalisation is e4-t19.

export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <Mark width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <path
        className="loop"
        d="M32 32C32 21 20.5 17 14 24.5S12 44 20 44c5.5 0 9.5-4.5 12-12 2.5-7.5 6.5-12 12-12 8 0 11 12 6 19.5S32 43 32 32z"
      />
      <path className="tail" d="M17 43.5 11 52l10.5-5.5z" />
      <path className="tail" d="M47 20.5 53 12l-10.5 5.5z" />
    </Mark>
  )
}

/** The mark and the wordmark side by side, named "LongTalk" for assistive tech */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <Wordmark>
      <LogoMark size={size} />
      <span>{strings.appName}</span>
    </Wordmark>
  )
}

const Mark = styled.svg`
  flex: none;

  .loop {
    fill: none;
    stroke: ${color.primary};
    stroke-width: 6.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .tail {
    fill: ${color.primary};
  }
`

const Wordmark = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-family: ${font.brand};
  font-weight: 700;
  font-size: 20px;
  letter-spacing: -0.2px;
  color: ${color.fg};
`
