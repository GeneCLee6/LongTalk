import { useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import styled from 'styled-components'
import { parseRoomInput } from '../../shared/room-id.ts'
import { createRoom, CreateRoomError, type CreateRoomProblem } from '../api/rooms.ts'
import { Button } from '../components/Button.tsx'
import { TextInput } from '../components/Field.tsx'
import { OfflineIcon } from '../components/icons.tsx'
import { InstallPrompt } from '../components/InstallPrompt.tsx'
import { RecordingRecovery } from '../components/RecordingRecovery.tsx'
import { LanguageSelect } from '../components/LanguageSelect.tsx'
import { ThemeSelect } from '../components/ThemeSelect.tsx'
import { Logo } from '../components/Logo.tsx'
import { useOnline } from '../pwa/online.ts'
import { getLocale, strings } from '../strings.ts'
import { breakpoint, color, font, fontSize, radius, space } from '../styles/tokens.ts'
import { turnstileToken } from '../turnstile.ts'

/** What went wrong creating a room (I1): the notice under the buttons */
type CreateProblem = Exclude<CreateRoomProblem['reason'], 'turnstile'> | 'verifyFailed'

function createProblemText(problem: CreateProblem, retryAfter: number): string {
  switch (problem) {
    case 'rateLimited':
      return strings.home.createRoomRateLimited(Math.max(1, Math.ceil(retryAfter / 60)))
    case 'blocked':
      return strings.home.createRoomBlocked
    case 'turnstileFailed':
    case 'verifyFailed':
      return strings.home.createRoomVerifyFailed
    case 'failed':
      return strings.home.createRoomFailed
  }
}

/** The home page (DESIGN.md §4.1): one primary action, a join box, three reasons. Follows the system scheme. */
export function HomePage() {
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [createProblem, setCreateProblem] = useState<{
    problem: CreateProblem
    retryAfter: number
  } | null>(null)
  const [verifying, setVerifying] = useState(false)
  // Where Turnstile's widget goes when it needs the person (most of the time it stays empty)
  const challenge = useRef<HTMLDivElement>(null)
  const [joinInput, setJoinInput] = useState('')
  const [joinInvalid, setJoinInvalid] = useState(false)
  // The shell opens offline (e4-t12); rooms need the network
  const online = useOnline()

  /**
   * POST /api/rooms; when the server asks for Turnstile (I1), the widget's token and once more.
   * Every refusal has its own notice.
   */
  async function onCreate() {
    setCreating(true)
    setCreateProblem(null)
    try {
      let roomId: string
      try {
        roomId = await createRoom()
      } catch (error) {
        if (!(error instanceof CreateRoomError) || error.problem.reason !== 'turnstile') throw error
        setVerifying(true)
        let token: string
        try {
          token = await turnstileToken(
            challenge.current!,
            error.problem.siteKey,
            getLocale().toLowerCase(),
          )
        } catch {
          throw new CreateRoomError({ reason: 'turnstileFailed' })
        } finally {
          setVerifying(false)
        }
        roomId = await createRoom(token)
      }
      navigate(`/r/${roomId}`)
    } catch (error) {
      const problem: CreateRoomProblem =
        error instanceof CreateRoomError ? error.problem : { reason: 'failed' }
      setCreateProblem({
        problem: problem.reason === 'turnstile' ? 'verifyFailed' : problem.reason,
        retryAfter: problem.reason === 'rateLimited' ? problem.retryAfter : 0,
      })
      setCreating(false)
    }
  }

  function onJoin(event: FormEvent) {
    event.preventDefault()
    const roomId = parseRoomInput(joinInput)
    if (roomId) navigate(`/r/${roomId}`)
    else setJoinInvalid(true)
  }

  return (
    <Page>
      <Top>
        <Logo size={30} />
        <Preferences>
          <ThemeSelect />
          <LanguageSelect />
        </Preferences>
      </Top>
      <Hero>
        <h1>{strings.tagline}</h1>
        <Intro>{strings.home.intro}</Intro>
        <Actions>
          <Button onClick={onCreate} disabled={creating}>
            {verifying
              ? strings.home.verifying
              : creating
                ? strings.home.creatingRoom
                : strings.home.createRoom}
          </Button>
          <JoinForm onSubmit={onJoin} noValidate>
            <TextInput
              aria-label={strings.home.joinLabel}
              aria-invalid={joinInvalid}
              aria-describedby={joinInvalid ? 'join-error' : undefined}
              placeholder={strings.home.joinPlaceholder}
              value={joinInput}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setJoinInput(event.target.value)
                setJoinInvalid(false)
              }}
            />
            <Button type="submit" variant="secondary" disabled={joinInput.trim() === ''}>
              {strings.home.join}
            </Button>
          </JoinForm>
        </Actions>
        {!online && (
          <Offline role="status">
            <OfflineIcon />
            {strings.pwa.offlineHome}
          </Offline>
        )}
        <Challenge ref={challenge} />
        {createProblem && (
          <Notice role="alert">
            {createProblemText(createProblem.problem, createProblem.retryAfter)}
          </Notice>
        )}
        {joinInvalid && (
          <Notice id="join-error" role="alert">
            {strings.home.joinInvalid}
          </Notice>
        )}
        {/* Install LongTalk (e4-t12): on the home page only, until used or dismissed */}
        <InstallPrompt />
        {/* A local recording left unsaved (I4, e8-t01): offered here and in the room */}
        <RecordingRecovery />
      </Hero>
      <Perks>
        {strings.home.perks.map((perk) => (
          <li key={perk.title}>
            <b>{perk.title}</b>
            <span>{perk.body}</span>
          </li>
        ))}
      </Perks>
    </Page>
  )
}

const Page = styled.main`
  min-height: 100dvh;
  display: grid;
  grid-template-rows: auto 1fr auto;
  font-family: ${font.current};
  background: ${color.bg};
  color: ${color.fg};
`

const Top = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: ${space(4)} ${space(7)};

  @media (max-width: ${breakpoint.phone}) {
    padding: ${space(4)};
  }
`

const Preferences = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: ${space(2)} ${space(4)};
`

const Hero = styled.section`
  display: grid;
  place-content: center;
  justify-items: center;
  gap: ${space(4)};
  padding: ${space(6)} ${space(5)};
  text-align: center;

  h1 {
    margin: 0;
    font-size: ${fontSize.titleWide};
    font-weight: 900;
    letter-spacing: 1px;
  }

  @media (max-width: ${breakpoint.phone}) {
    h1 {
      font-size: ${fontSize.title};
    }
  }
`

const Intro = styled.p`
  max-width: 34em;
  margin: 0;
  color: ${color.muted};
`

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: ${space(3)};
  width: min(560px, 100%);
`

const JoinForm = styled.form`
  display: flex;
  flex: 1 1 280px;
  gap: ${space(2)};

  /* The box takes the room; 「加入」 never squeezes into two lines */
  > button {
    flex: none;
    white-space: nowrap;
  }
`

/** Turnstile's widget, when it asks for a click; takes no room while empty */
const Challenge = styled.div`
  &:empty {
    display: none;
  }
`

const Notice = styled.p`
  margin: 0;
  color: ${color.danger};
`

const Offline = styled.p`
  display: inline-flex;
  align-items: center;
  gap: ${space(2)};
  margin: 0;
  font-weight: 600;

  svg {
    flex: none;
    width: 20px;
    height: 20px;
    color: ${color.warn};
  }
`

const Perks = styled.ul`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: ${space(3)};
  margin: 0;
  padding: 0 ${space(7)} ${space(7)};
  list-style: none;

  li {
    display: grid;
    gap: ${space(1)};
    padding: ${space(3.5)} ${space(4)};
    border: 1px solid ${color.line};
    border-radius: ${radius.tile};
    background: ${color.surface};
  }
  span {
    font-size: ${fontSize.small};
    color: ${color.muted};
  }

  @media (max-width: ${breakpoint.phone}) {
    padding: 0 ${space(4)} ${space(4)};
  }
`
