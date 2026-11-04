import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import styled from 'styled-components'
import { isMeetingId, meetingPhase, type PublicMeeting } from '../../shared/meeting.ts'
import { fetchPublicMeeting } from '../api/meetings.ts'
import { Button } from '../components/Button.tsx'
import { Logo } from '../components/Logo.tsx'
import { countdownText, meetingWhen } from '../meeting/invite.ts'
import { browserTimeZone, formatMeetingClock, strings } from '../strings.ts'
import { color, fontSize, space } from '../styles/tokens.ts'
import { ButtonLink, Card, Content, Muted, Page, Small, Top } from './accountStyles.tsx'
import { CalendarActions } from './CalendarActions.tsx'

type State =
  | { at: 'loading' }
  | { at: 'notFound' }
  | { at: 'failed' }
  | { at: 'ready'; meeting: PublicMeeting }

/**
 * /m/<id> (I3, e1-t14): a scheduled meeting's public page, for anyone with the link (no sign-in).
 * The title, the time in the viewer's zone (and the organizer's, when it differs), a countdown,
 * the join button and the calendar links. Of the organizer only the display name. The join
 * button turns on MEETING_JOIN_EARLY_MS before the start (the Worker names the room only from
 * then on) and stays on after: the room is a persistent room, there before and after. Lazy, like
 * /me: none of it is in the home page's JS.
 */
export default function MeetingPage() {
  const { meetingId = '' } = useParams()
  const [state, setState] = useState<State>(() =>
    isMeetingId(meetingId) ? { at: 'loading' } : { at: 'notFound' },
  )
  const [now, setNow] = useState(Date.now)

  useEffect(() => {
    if (!isMeetingId(meetingId)) return
    let live = true
    fetchPublicMeeting(meetingId).then(
      (meeting) => live && setState(meeting ? { at: 'ready', meeting } : { at: 'notFound' }),
      () => live && setState({ at: 'failed' }),
    )
    return () => {
      live = false
    }
  }, [meetingId])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const meeting = state.at === 'ready' ? state.meeting : null
  // The join window opened while the page was open: ask again for the room
  const waitingForRoom = meeting !== null && meeting.room === null && now >= meeting.joinFrom
  useEffect(() => {
    if (!waitingForRoom) return
    let live = true
    fetchPublicMeeting(meetingId).then(
      (fresh) => live && fresh && fresh.room !== null && setState({ at: 'ready', meeting: fresh }),
      () => {},
    )
    return () => {
      live = false
    }
  }, [waitingForRoom, meetingId])

  useEffect(() => {
    document.title = `${meeting?.title ?? strings.meetings.page.label} · ${strings.appName}`
    return () => {
      document.title = strings.appName
    }
  }, [meeting?.title])

  return (
    <Page>
      <Top>
        <Logo size={28} />
        <Link to="/">{strings.meetings.page.home}</Link>
      </Top>
      <Content>
        {!meeting && <h1>{strings.meetings.page.label}</h1>}
        {state.at === 'loading' && <p role="status">{strings.meetings.page.loading}</p>}
        {state.at === 'notFound' && <p role="alert">{strings.meetings.page.notFound}</p>}
        {state.at === 'failed' && <p role="alert">{strings.meetings.page.failed}</p>}
        {meeting && <MeetingDetails meeting={meeting} now={now} />}
      </Content>
    </Page>
  )
}

function MeetingDetails({ meeting, now }: { meeting: PublicMeeting; now: number }) {
  const phase = meetingPhase(meeting, now)
  const localZone = browserTimeZone()
  const status =
    phase === 'live'
      ? strings.meetings.page.live
      : phase === 'over'
        ? strings.meetings.page.over
        : strings.meetings.page.startsIn(countdownText(meeting.startsAt - now))
  return (
    <>
      <Kicker>{strings.meetings.page.label}</Kicker>
      <h1>{meeting.title}</h1>
      <Card aria-labelledby="meeting-when">
        <h2 id="meeting-when">{strings.meetings.yourTime(meetingWhen(meeting))}</h2>
        {meeting.timeZone !== localZone && (
          <Muted>{strings.meetings.organizerTime(meetingWhen(meeting, meeting.timeZone))}</Muted>
        )}
        <Muted>{strings.meetings.page.organizer(meeting.organizer)}</Muted>
        <Status $phase={phase}>{status}</Status>
        <div>
          {meeting.room ? (
            <ButtonLink to={`/r/${meeting.room}`}>{strings.meetings.page.join}</ButtonLink>
          ) : (
            <Button disabled aria-describedby="join-opens">
              {strings.meetings.page.join}
            </Button>
          )}
        </div>
        {!meeting.room && (
          <Small id="join-opens">{strings.meetings.page.joinOpens(formatMeetingClock(meeting.joinFrom))}</Small>
        )}
      </Card>
      {meeting.description && (
        <Card aria-label={strings.meetings.page.description}>
          <Description>{meeting.description}</Description>
        </Card>
      )}
      <Card aria-labelledby="meeting-calendar">
        <h2 id="meeting-calendar">{strings.meetings.page.addToCalendar}</h2>
        <CalendarActions meeting={meeting} origin={location.origin} />
      </Card>
    </>
  )
}

const Kicker = styled.p`
  margin: 0;
  color: ${color.muted};
  font-size: ${fontSize.small};
  font-weight: 600;
`

const Status = styled.p<{ $phase: string }>`
  margin: 0;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: ${({ $phase }) => ($phase === 'over' ? color.muted : color.fg)};
`

const Description = styled.p`
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  padding-top: ${space(1)};
`
