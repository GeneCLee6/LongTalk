import { Link, useParams } from 'react-router-dom'
import styled from 'styled-components'
import { isRoomId } from '../../shared/room-id.ts'
import { useRoomConnection } from '../room/useRoomConnection.ts'
import type { RoomConnectionState } from '../room/RoomConnection.ts'
import { strings } from '../strings.ts'
import { color, font } from '../styles/tokens.ts'

export default function RoomPage() {
  const { roomId = '' } = useParams()
  // The room is dark whatever the system scheme (DESIGN.md §1.2)
  return <Main data-theme="dark">{isRoomId(roomId) ? <Room roomId={roomId} /> : <NotFound />}</Main>
}

function Room({ roomId }: { roomId: string }) {
  const state = useRoomConnection(roomId)
  if (state.status === 'notFound') return <NotFound />
  return (
    <>
      <h1>{strings.room.title(roomId)}</h1>
      <p role="status">{statusText(state)}</p>
    </>
  )
}

function statusText({ status, view }: RoomConnectionState): string {
  switch (status) {
    case 'connecting':
    case 'notFound':
      return strings.room.connecting
    case 'open':
      return strings.room.memberCount(Object.keys(view?.members ?? {}).length)
    case 'full':
      return strings.room.full
    case 'outdated':
      return strings.room.outdated
    case 'closed':
      return strings.room.closed
  }
}

function NotFound() {
  return (
    <>
      <p role="alert">{strings.room.notFound}</p>
      <Link to="/">{strings.room.backHome}</Link>
    </>
  )
}

const Main = styled.main`
  min-height: 100dvh;
  display: grid;
  place-content: center;
  text-align: center;
  font-family: ${font.ui};
  background: ${color.bg};
  color: ${color.fg};

  a {
    color: ${color.brand};
  }
`
