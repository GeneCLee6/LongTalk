import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import styled from 'styled-components'
import { createRoom } from '../api/rooms.ts'
import { strings } from '../strings.ts'
import { color, font } from '../styles/tokens.ts'

export function HomePage() {
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [failed, setFailed] = useState(false)

  async function onCreate() {
    setCreating(true)
    setFailed(false)
    try {
      const roomId = await createRoom()
      navigate(`/r/${roomId}`)
    } catch {
      setFailed(true)
      setCreating(false)
    }
  }

  return (
    <Main>
      <h1>{strings.appName}</h1>
      <p>{strings.tagline}</p>
      <PrimaryButton type="button" onClick={onCreate} disabled={creating}>
        {creating ? strings.home.creatingRoom : strings.home.createRoom}
      </PrimaryButton>
      {failed && <Muted role="alert">{strings.home.createRoomFailed}</Muted>}
    </Main>
  )
}

const Main = styled.main`
  min-height: 100dvh;
  display: grid;
  place-content: center;
  justify-items: center;
  text-align: center;
  font-family: ${font.ui};
  background: ${color.bg};
  color: ${color.text};

  h1 {
    color: ${color.brand};
    margin: 0 0 8px;
  }
`

// A2 (e4-t01) replaces this with the base Button component
const PrimaryButton = styled.button`
  margin-top: 16px;
  padding: 12px 24px;
  border: 0;
  border-radius: 8px;
  font: inherit;
  font-weight: 600;
  background: ${color.brand};
  color: ${color.bg};
  cursor: pointer;

  &:disabled {
    opacity: 0.6;
    cursor: progress;
  }
`

const Muted = styled.p`
  color: ${color.textMuted};
`
