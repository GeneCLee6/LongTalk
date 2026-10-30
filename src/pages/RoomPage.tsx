import { useParams } from 'react-router-dom'
import styled from 'styled-components'
import { strings } from '../strings.ts'
import { color, font } from '../styles/tokens.ts'

export default function RoomPage() {
  const { roomId = '' } = useParams()
  return (
    <Main>
      <h1>{strings.room.title(roomId)}</h1>
      <p>{strings.room.comingSoon}</p>
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
`
