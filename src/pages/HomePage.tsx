import styled from 'styled-components'
import { strings } from '../strings.ts'
import { color, font } from '../styles/tokens.ts'

export function HomePage() {
  return (
    <Main>
      <h1>{strings.appName}</h1>
      <p>{strings.tagline}</p>
      <Muted>{strings.home.comingSoon}</Muted>
    </Main>
  )
}

const Main = styled.main`
  min-height: 100dvh;
  display: grid;
  place-content: center;
  text-align: center;
  font-family: ${font.ui};
  background: ${color.bg};
  color: ${color.text};

  h1 {
    color: ${color.brand};
    margin: 0 0 8px;
  }
`

const Muted = styled.p`
  color: ${color.textMuted};
`
