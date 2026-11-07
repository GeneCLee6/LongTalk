import { useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import styled from 'styled-components'
import {
  MAX_AGENDA_ITEMS,
  MAX_AGENDA_MINUTES,
  MAX_AGENDA_TITLE_CHARS,
  MAX_POLL_OPTIONS,
  MAX_POLL_OPTION_CHARS,
  MAX_POLL_QUESTION_CHARS,
  MAX_TIMER_SECONDS,
  MIN_POLL_OPTIONS,
  type AgendaInfo,
  type AgendaItem,
  type PollView,
  type TimerInfo,
} from '../../shared/interact.ts'
import {
  parseAgendaItems,
  parsePollStart,
  type ClientMessage,
  type PollStartMessage,
} from '../../shared/protocol.ts'
import { strings } from '../strings.ts'
import { color, fontSize, radius, space } from '../styles/tokens.ts'
import { Button } from './Button.tsx'
import { TextField, TextInput } from './Field.tsx'
import { PollResults } from './PollResults.tsx'

export interface InteractPanelProps {
  poll: PollView | null
  /** What we answered to the poll on now (`pollVoted`); null before we do */
  myVote: readonly number[] | null
  timer: TimerInfo | null
  agenda: AgendaInfo | null
  /** A host or co-host: shared/roles.ts `poll`, `timer`, `agenda`; RoomDO checks again */
  manage: boolean
  send: (message: ClientMessage) => void
}

/**
 * 互動 (L5, e5-t07, e5-t08), a lazy chunk beside chat and participants: answer the poll and watch its
 * results; a host or co-host also starts and ends polls, and sets the countdown and the agenda (the
 * top bar and the agenda bar show those to everyone). The room decides everything.
 */
export default function InteractPanel({
  poll,
  myVote,
  timer,
  agenda,
  manage,
  send,
}: InteractPanelProps) {
  // What had the focus can go (the form once the poll starts, 結束投票 once it ends): the focus stays
  // in the panel rather than falling to the page, where Esc and Tab would start over
  const panel = useRef<HTMLDivElement>(null)
  const focusInside = useRef(false)
  useLayoutEffect(() => {
    if (focusInside.current && document.activeElement === document.body) panel.current?.focus()
    focusInside.current = panel.current?.contains(document.activeElement) ?? false
  })
  return (
    <Panel ref={panel} tabIndex={-1}>
      <Section aria-labelledby="interact-poll">
        <h3 id="interact-poll">{strings.poll.title}</h3>
        {poll ? (
          // A new poll starts with nothing picked
          <PollCard key={poll.id} poll={poll} myVote={myVote} manage={manage} send={send} />
        ) : manage ? (
          <PollForm onStart={(message) => send(message)} />
        ) : (
          <Muted>{strings.poll.none}</Muted>
        )}
      </Section>
      {manage && (
        <Section aria-labelledby="interact-timer">
          <h3 id="interact-timer">{strings.timer.title}</h3>
          <TimerForm timer={timer} send={send} />
        </Section>
      )}
      {manage ? (
        <Section aria-labelledby="interact-agenda">
          <h3 id="interact-agenda">{strings.agenda.title}</h3>
          <AgendaForm agenda={agenda} send={send} />
        </Section>
      ) : null}
    </Panel>
  )
}

function PollCard({
  poll,
  myVote,
  manage,
  send,
}: {
  poll: PollView
  myVote: readonly number[] | null
  manage: boolean
  send: (message: ClientMessage) => void
}) {
  const [picked, setPicked] = useState<readonly number[] | null>(null)
  const chosen = picked ?? myVote ?? []
  const voted = myVote !== null
  // Nothing new picked since the answer we gave: nothing to send
  const unchanged = voted && [...chosen].sort().join() === [...myVote].sort().join()
  const toggle = (index: number) =>
    setPicked(
      !poll.multi
        ? [index]
        : chosen.includes(index)
          ? chosen.filter((choice) => choice !== index)
          : [...chosen, index],
    )
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (chosen.length === 0) return
    send({ t: 'pollVote', poll: poll.id, choices: [...chosen] })
    setPicked(null)
  }
  return (
    <Card>
      <Question>{poll.question}</Question>
      <Muted>
        {strings.poll.meta(poll.by, poll.multi, poll.anonymous)}
      </Muted>
      <Answer onSubmit={submit} aria-label={strings.poll.answerLabel}>
        <Choices>
          {poll.options.map((option, index) => (
            <Choice key={index}>
              <input
                type={poll.multi ? 'checkbox' : 'radio'}
                name={`poll-${poll.id}`}
                checked={chosen.includes(index)}
                onChange={() => toggle(index)}
              />
              <span>{option}</span>
            </Choice>
          ))}
        </Choices>
        <Button type="submit" disabled={chosen.length === 0 || unchanged}>
          {voted ? strings.poll.change : strings.poll.vote}
        </Button>
      </Answer>
      <Muted aria-live="polite">{strings.poll.voters(poll.voters)}</Muted>
      <PollResults
        options={poll.options}
        counts={poll.counts}
        voters={poll.voters}
        votes={poll.votes}
      />
      {manage && (
        <Button variant="secondary" onClick={() => send({ t: 'pollEnd', poll: poll.id })}>
          {strings.poll.end}
        </Button>
      )}
    </Card>
  )
}

function PollForm({ onStart }: { onStart: (message: PollStartMessage) => void }) {
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState<readonly string[]>(['', ''])
  const [multi, setMulti] = useState(false)
  const [anonymous, setAnonymous] = useState(false)
  // What the room would take: the same check it does. Empty rows are simply left out
  const message = parsePollStart({
    question,
    options: options.filter((option) => option.trim() !== ''),
    multi,
    anonymous,
  })
  return (
    <Card
      as="form"
      noValidate
      aria-label={strings.poll.formLabel}
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        if (message) onStart(message)
      }}
    >
      <TextField
        label={strings.poll.question}
        value={question}
        maxLength={MAX_POLL_QUESTION_CHARS}
        onChange={(event) => setQuestion(event.target.value)}
      />
      {options.map((option, index) => (
        <Row key={index}>
          <TextField
            label={strings.poll.option(index + 1)}
            value={option}
            maxLength={MAX_POLL_OPTION_CHARS}
            onChange={(event) =>
              setOptions(options.map((other, at) => (at === index ? event.target.value : other)))
            }
          />
          {options.length > MIN_POLL_OPTIONS && (
            <Button
              variant="ghost"
              aria-label={strings.poll.removeOption(index + 1)}
              onClick={() => setOptions(options.filter((_, at) => at !== index))}
            >
              {strings.poll.remove}
            </Button>
          )}
        </Row>
      ))}
      <Button
        variant="secondary"
        disabled={options.length >= MAX_POLL_OPTIONS}
        onClick={() => setOptions([...options, ''])}
      >
        {strings.poll.addOption}
      </Button>
      <Check>
        <input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} />
        {strings.poll.multi}
      </Check>
      <Check>
        <input
          type="checkbox"
          checked={anonymous}
          onChange={(e) => setAnonymous(e.target.checked)}
        />
        {strings.poll.anonymous}
      </Check>
      <Button type="submit" disabled={!message}>
        {strings.poll.start}
      </Button>
    </Card>
  )
}

function TimerForm({
  timer,
  send,
}: {
  timer: TimerInfo | null
  send: (message: ClientMessage) => void
}) {
  const [minutes, setMinutes] = useState('5')
  const value = Number(minutes)
  const seconds = Math.round(value * 60)
  const valid = Number.isFinite(value) && seconds >= 1 && seconds <= MAX_TIMER_SECONDS
  return (
    <Card
      as="form"
      noValidate
      aria-label={strings.timer.title}
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        if (valid) send({ t: 'timer', seconds })
      }}
    >
      <TextField
        label={strings.timer.minutes}
        type="number"
        min={0}
        max={MAX_TIMER_SECONDS / 60}
        step="any"
        inputMode="decimal"
        value={minutes}
        aria-invalid={!valid}
        onChange={(event) => setMinutes(event.target.value)}
      />
      <Row>
        <Button type="submit" disabled={!valid}>
          {timer ? strings.timer.restart : strings.timer.start}
        </Button>
        {timer && (
          <Button variant="secondary" onClick={() => send({ t: 'timer', seconds: null })}>
            {strings.timer.stop}
          </Button>
        )}
      </Row>
    </Card>
  )
}

type AgendaDraft = { title: string; minutes: string }

const draftOf = (items: readonly AgendaItem[]): AgendaDraft[] =>
  items.length > 0
    ? items.map(({ title, minutes }) => ({ title, minutes: String(minutes) }))
    : [{ title: '', minutes: '5' }]

function AgendaForm({
  agenda,
  send,
}: {
  agenda: AgendaInfo | null
  send: (message: ClientMessage) => void
}) {
  const [rows, setRows] = useState<readonly AgendaDraft[]>(() => draftOf(agenda?.items ?? []))
  // Saved (by us, or by a co-host): the form starts over from what the room has
  const saved = JSON.stringify(agenda?.items ?? [])
  const [seen, setSeen] = useState(saved)
  if (saved !== seen) {
    setSeen(saved)
    setRows(draftOf(agenda?.items ?? []))
  }
  const change = (index: number, changes: Partial<AgendaDraft>) =>
    setRows(rows.map((row, at) => (at === index ? { ...row, ...changes } : row)))
  // What the room would take: the same check it does. Rows with no title are simply left out
  const items = parseAgendaItems(
    rows
      .filter((row) => row.title.trim() !== '')
      .map((row) => ({ title: row.title, minutes: Number(row.minutes) })),
  )
  return (
    <Card
      as="form"
      noValidate
      aria-label={strings.agenda.title}
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        if (items && items.length > 0) send({ t: 'agenda', items })
      }}
    >
      {rows.map((row, index) => (
        <Row key={index}>
          <TextField
            label={strings.agenda.item(index + 1)}
            value={row.title}
            maxLength={MAX_AGENDA_TITLE_CHARS}
            onChange={(event) => change(index, { title: event.target.value })}
          />
          <MinutesField>
            <label>
              {strings.agenda.minutesLabel}
              <TextInput
                type="number"
                min={1}
                max={MAX_AGENDA_MINUTES}
                inputMode="numeric"
                aria-label={strings.agenda.minutesOf(index + 1)}
                value={row.minutes}
                onChange={(event) => change(index, { minutes: event.target.value })}
              />
            </label>
          </MinutesField>
          {rows.length > 1 && (
            <Button
              variant="ghost"
              aria-label={strings.agenda.removeItem(index + 1)}
              onClick={() => setRows(rows.filter((_, at) => at !== index))}
            >
              {strings.poll.remove}
            </Button>
          )}
        </Row>
      ))}
      <Button
        variant="secondary"
        disabled={rows.length >= MAX_AGENDA_ITEMS}
        onClick={() => setRows([...rows, { title: '', minutes: '5' }])}
      >
        {strings.agenda.add}
      </Button>
      <Row>
        <Button type="submit" disabled={!items || items.length === 0}>
          {strings.agenda.save}
        </Button>
        {agenda && (
          <Button variant="secondary" onClick={() => send({ t: 'agenda', items: [] })}>
            {strings.agenda.clear}
          </Button>
        )}
      </Row>
    </Card>
  )
}

const Panel = styled.div`
  display: grid;
  align-content: start;
  gap: ${space(4)};
  flex: 1;
  min-height: 0;
  padding: ${space(3)};
  overflow-y: auto;
  overscroll-behavior: contain;

  /* Only ever focused by the code above, so nothing to point at */
  &:focus {
    outline: none;
  }
`

const Section = styled.section`
  display: grid;
  gap: ${space(2)};

  h3 {
    margin: 0;
    font-size: ${fontSize.small};
    font-weight: 700;
  }
`

const Card = styled.div`
  display: grid;
  gap: ${space(2)};
  padding: ${space(3)};
  border: 1px solid ${color.line};
  border-radius: ${radius.button};
`

const Question = styled.p`
  margin: 0;
  font-weight: 700;
  overflow-wrap: anywhere;
`

const Muted = styled.p`
  margin: 0;
  color: ${color.muted};
  font-size: ${fontSize.small};
`

const Answer = styled.form`
  display: grid;
  gap: ${space(2)};
`

const Choices = styled.div`
  display: grid;
  gap: ${space(1)};
`

const Choice = styled.label`
  display: flex;
  align-items: center;
  gap: ${space(2)};
  min-height: 44px;
  padding: 0 ${space(2)};
  border-radius: ${radius.button};
  font-size: ${fontSize.small};
  overflow-wrap: anywhere;
  cursor: pointer;

  &:hover {
    background: ${color.hover};
  }
  input {
    flex: none;
  }
`

const Row = styled.div`
  display: flex;
  align-items: flex-end;
  gap: ${space(2)};

  > label {
    flex: 1;
    min-width: 0;
  }
`

const MinutesField = styled.div`
  flex: none;
  width: 72px;

  label {
    display: grid;
    gap: ${space(1)};
    font-size: ${fontSize.small};
  }
  input {
    padding-inline: ${space(1)};
  }
`

const Check = styled.label`
  display: flex;
  align-items: center;
  gap: ${space(2)};
  min-height: 44px;
  font-size: ${fontSize.small};
  cursor: pointer;
`
