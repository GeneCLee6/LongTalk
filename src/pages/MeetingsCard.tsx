import { useId, useState, type FormEvent } from 'react'
import type { PersistentRoomInfo } from '../../shared/account.ts'
import {
  MAX_MEETING_DESCRIPTION_CHARS,
  MAX_MEETING_TITLE_CHARS,
  MEETING_DURATIONS,
  MEETING_RETENTION_MS,
  meetingEnd,
  parseMeetingInput,
  type MeetingInfo,
  type MeetingInput,
  type MeetingProblem,
} from '../../shared/meeting.ts'
import { createMeeting, deleteMeeting, updateMeeting } from '../api/account.ts'
import { Button } from '../components/Button.tsx'
import { SelectField, TextField } from '../components/Field.tsx'
import { canCopy } from '../media/capabilities.ts'
import {
  fromLocalInputs,
  invitationText,
  meetingWhen,
  toLocalInputs,
  zoneLabel,
} from '../meeting/invite.ts'
import { browserTimeZone, strings } from '../strings.ts'
import {
  Actions,
  Card,
  Check,
  FieldLabel,
  FieldRow,
  Form,
  Item,
  ItemHead,
  List,
  Muted,
  Small,
  StyledLink,
  TextArea,
} from './accountStyles.tsx'
import { CalendarActions } from './CalendarActions.tsx'

// /me's 「預定會議」 (I3, e1-t14): schedule, edit and delete meetings in your persistent rooms;
// copy the invitation, download the .ics, open Google or Outlook's new-event form. Upcoming first
// (soonest at the top), then the past ones until they are deleted. Every rule is the Worker's
// (shared/meeting.ts checks the form the same way before it sends).

type Run = (action: () => Promise<unknown>, ok?: string, reload?: boolean) => Promise<boolean>
type Ask = (title: string, body: string, label: string, action: () => void) => void

export function MeetingsCard({
  meetings,
  rooms,
  organizer,
  run,
  ask,
}: {
  meetings: MeetingInfo[]
  rooms: PersistentRoomInfo[]
  organizer: string
  run: Run
  ask: Ask
}) {
  const [creating, setCreating] = useState(false)
  const [now] = useState(Date.now)
  const upcoming = meetings.filter((meeting) => meetingEnd(meeting) > now)
  const past = meetings.filter((meeting) => meetingEnd(meeting) <= now).reverse()
  const retentionDays = Math.round(MEETING_RETENTION_MS / 86_400_000)
  const item = (meeting: MeetingInfo) => (
    <MeetingItem
      key={meeting.id}
      meeting={meeting}
      rooms={rooms}
      organizer={organizer}
      run={run}
      ask={ask}
    />
  )

  return (
    <Card aria-labelledby="meetings">
      <h2 id="meetings">{strings.meetings.title}</h2>
      <Muted>{strings.meetings.body}</Muted>
      <h3>{strings.meetings.upcoming}</h3>
      {upcoming.length === 0 ? <p>{strings.meetings.none}</p> : <List>{upcoming.map(item)}</List>}
      {past.length > 0 && (
        <details>
          <summary>{strings.meetings.past(past.length)}</summary>
          <Small>{strings.meetings.pastHint(retentionDays)}</Small>
          <List>{past.map(item)}</List>
        </details>
      )}
      {rooms.length === 0 ? (
        <Muted>{strings.meetings.needRoom}</Muted>
      ) : creating ? (
        <MeetingForm meeting={null} rooms={rooms} run={run} onDone={() => setCreating(false)} />
      ) : (
        <div>
          <Button onClick={() => setCreating(true)}>{strings.meetings.create}</Button>
        </div>
      )}
    </Card>
  )
}

function MeetingItem({
  meeting,
  rooms,
  organizer,
  run,
  ask,
}: {
  meeting: MeetingInfo
  rooms: PersistentRoomInfo[]
  organizer: string
  run: Run
  ask: Ask
}) {
  const [editing, setEditing] = useState(false)
  const [inviting, setInviting] = useState(false)
  const [copyable] = useState(canCopy)
  const room = rooms.find((r) => r.slug === meeting.roomSlug)
  const origin = location.origin
  const localZone = browserTimeZone()
  const copy = (password: string | null) =>
    run(
      () => navigator.clipboard.writeText(invitationText(meeting, organizer, origin, password)),
      strings.meetings.copied,
      false,
    )

  return (
    <Item>
      <ItemHead>
        <b>{meeting.title}</b>
        <span>{meetingWhen(meeting)}</span>
        {meeting.timeZone !== localZone && (
          <Small>{strings.meetings.organizerTime(meetingWhen(meeting, meeting.timeZone))}</Small>
        )}
        <Small>{strings.meetings.roomLink(meeting.roomSlug)}</Small>
      </ItemHead>
      <Actions>
        <StyledLink to={`/m/${meeting.id}`}>{strings.meetings.openPage}</StyledLink>
        {copyable && (
          <Button
            variant="secondary"
            aria-label={strings.meetings.copyInviteLabel(meeting.title)}
            aria-expanded={room?.password ? inviting : undefined}
            onClick={() => (room?.password ? setInviting((on) => !on) : void copy(null))}
          >
            {strings.meetings.copyInvite}
          </Button>
        )}
        <Button
          variant="secondary"
          aria-expanded={editing}
          aria-label={strings.meetings.editLabel(meeting.title)}
          onClick={() => setEditing((on) => !on)}
        >
          {strings.meetings.edit}
        </Button>
        <Button
          variant="ghost"
          aria-label={strings.meetings.deleteLabel(meeting.title)}
          onClick={() =>
            ask(
              strings.meetings.deleteTitle,
              strings.meetings.deleteBody,
              strings.meetings.delete,
              () => void run(() => deleteMeeting(meeting.id), strings.meetings.deleted),
            )
          }
        >
          {strings.meetings.delete}
        </Button>
      </Actions>
      <CalendarActions meeting={meeting} origin={origin} />
      {inviting && <InvitePassword onCopy={(password) => void copy(password).then(() => setInviting(false))} />}
      {editing && (
        <MeetingForm meeting={meeting} rooms={rooms} run={run} onDone={() => setEditing(false)} />
      )}
    </Item>
  )
}

/** The owner's explicit choice to put the room password in this one copy (never saved) */
function InvitePassword({ onCopy }: { onCopy: (password: string | null) => void }) {
  const [include, setInclude] = useState(false)
  const [password, setPassword] = useState('')
  const hint = useId()
  return (
    <Form
      aria-label={strings.meetings.copyInvite}
      onSubmit={(event) => {
        event.preventDefault()
        onCopy(include && password.trim() !== '' ? password.trim() : null)
      }}
    >
      <Check>
        <input type="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} />
        {strings.meetings.invitePassword}
      </Check>
      {include && (
        <TextField
          label={strings.meetings.invitePasswordLabel}
          type="password"
          autoComplete="off"
          value={password}
          aria-describedby={hint}
          onChange={(event) => setPassword(event.target.value)}
        />
      )}
      {include && <Small id={hint}>{strings.meetings.invitePasswordHint}</Small>}
      <div>
        <Button type="submit">{strings.meetings.copyNow}</Button>
      </div>
    </Form>
  )
}

const clock = () => Date.now()

/** Rounded up to the next quarter hour, an hour from now: where a new meeting's time starts */
function defaultStart(): number {
  const quarter = 15 * 60_000
  return Math.ceil((clock() + 60 * 60_000) / quarter) * quarter
}

function MeetingForm({
  meeting,
  rooms,
  run,
  onDone,
}: {
  meeting: MeetingInfo | null
  rooms: PersistentRoomInfo[]
  run: Run
  onDone: () => void
}) {
  const [initialAt] = useState(() => meeting?.startsAt ?? defaultStart())
  const [initial] = useState(() => toLocalInputs(initialAt))
  const [title, setTitle] = useState(meeting?.title ?? '')
  const [description, setDescription] = useState(meeting?.description ?? '')
  const [date, setDate] = useState(initial.date)
  const [time, setTime] = useState(initial.time)
  const [duration, setDuration] = useState(meeting?.durationMin ?? 60)
  const [roomSlug, setRoomSlug] = useState(
    meeting && rooms.some((r) => r.slug === meeting.roomSlug) ? meeting.roomSlug : (rooms[0]?.slug ?? ''),
  )
  const [shown, setShown] = useState<MeetingProblem | null>(null)
  const [busy, setBusy] = useState(false)
  const descriptionId = useId()
  const problemId = useId()
  const zone = browserTimeZone()
  const startsAt = fromLocalInputs(date, time)
  const durations: number[] = [...MEETING_DURATIONS]
  if (!durations.includes(duration)) durations.push(duration)
  durations.sort((a, b) => a - b)
  const room = rooms.find((r) => r.slug === roomSlug)
  const flags = room
    ? [room.waitingRoom && strings.account.waitingRoom, room.password && strings.account.passwordSet].filter(Boolean)
    : []
  const heading = meeting ? strings.meetings.editTitle(meeting.title) : strings.meetings.newTitle

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const parsed = parseMeetingInput(
      { title, description, startsAt: startsAt ?? undefined, durationMin: duration, timeZone: zone, roomSlug },
      clock(),
      meeting?.startsAt ?? null,
    )
    if ('problem' in parsed) {
      setShown(parsed.problem)
      return
    }
    setShown(null)
    setBusy(true)
    const input: MeetingInput = parsed.input
    const ok = await run(
      () => (meeting ? updateMeeting(meeting.id, input) : createMeeting(input)),
      strings.meetings.saved,
    )
    setBusy(false)
    if (ok) onDone()
  }

  const invalid = (problem: MeetingProblem | MeetingProblem[]) =>
    shown !== null && ([] as MeetingProblem[]).concat(problem).includes(shown)

  return (
    <Form aria-label={heading} onSubmit={onSubmit} noValidate>
      <h3>{heading}</h3>
      <TextField
        label={strings.meetings.titleLabel}
        value={title}
        maxLength={MAX_MEETING_TITLE_CHARS * 2}
        autoComplete="off"
        aria-invalid={invalid('title')}
        aria-describedby={shown ? problemId : undefined}
        onChange={(event) => setTitle(event.target.value)}
      />
      <FieldLabel>
        {strings.meetings.descriptionLabel}
        <TextArea
          value={description}
          maxLength={MAX_MEETING_DESCRIPTION_CHARS * 2}
          aria-invalid={invalid('description')}
          aria-describedby={descriptionId}
          onChange={(event) => setDescription(event.target.value)}
        />
      </FieldLabel>
      <Small id={descriptionId}>{strings.meetings.descriptionHint(MAX_MEETING_DESCRIPTION_CHARS)}</Small>
      <FieldRow>
        <TextField
          label={strings.meetings.dateLabel}
          type="date"
          value={date}
          required
          aria-invalid={invalid(['start', 'past', 'ahead'])}
          onChange={(event) => setDate(event.target.value)}
        />
        <TextField
          label={strings.meetings.timeLabel}
          type="time"
          step={300}
          value={time}
          required
          aria-invalid={invalid(['start', 'past', 'ahead'])}
          onChange={(event) => setTime(event.target.value)}
        />
        <SelectField
          label={strings.meetings.durationLabel}
          value={duration}
          onChange={(event) => setDuration(Number(event.target.value))}
        >
          {durations.map((minutes) => (
            <option key={minutes} value={minutes}>
              {strings.meetings.duration(minutes)}
            </option>
          ))}
        </SelectField>
      </FieldRow>
      <Small>{strings.meetings.timeZoneNote(`${zoneLabel(startsAt ?? initialAt)} · ${zone}`)}</Small>
      <SelectField
        label={strings.meetings.roomLabel}
        value={roomSlug}
        aria-invalid={invalid('room')}
        onChange={(event) => setRoomSlug(event.target.value)}
      >
        {rooms.map((r) => (
          <option key={r.slug} value={r.slug}>
            {r.name ? `${r.name} (/r/${r.slug})` : `/r/${r.slug}`}
          </option>
        ))}
      </SelectField>
      <Small>
        {flags.length > 0 && `${strings.meetings.roomFlags(flags.join(' · '))} `}
        {strings.meetings.roomSettingsHint}
      </Small>
      <Small id={problemId} role="alert">
        {shown ? strings.meetings.problems[shown] : ''}
      </Small>
      <Actions>
        <Button type="submit" disabled={busy}>
          {busy ? strings.meetings.saving : strings.meetings.save}
        </Button>
        <Button variant="secondary" onClick={onDone}>
          {strings.meetings.cancel}
        </Button>
      </Actions>
    </Form>
  )
}
