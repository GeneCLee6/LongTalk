import { useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import styled from 'styled-components'
import {
  BREAKOUT_RECALL_MS,
  MAX_BREAKOUT_GROUPS,
  MAX_BREAKOUT_MINUTES,
  MAX_BREAKOUT_NAME_CHARS,
  MAX_BROADCAST_CHARS,
  autoAssign,
  type BreakoutView,
} from '../../shared/breakout.ts'
import {
  normalizeName,
  parseBreakoutOpen,
  type ClientMessage,
  type Member,
} from '../../shared/protocol.ts'
import { formatElapsed } from '../room/elapsed.ts'
import { strings } from '../strings.ts'
import { color, fontSize, radius, space } from '../styles/tokens.ts'
import { secondsOf, useBreakoutRemaining } from './useBreakoutClock.ts'
import { Button } from './Button.tsx'
import { Select, SelectField, TextField } from './Field.tsx'

export interface BreakoutPanelProps {
  /** The rooms while they are open (the whole room's view); null before */
  breakout: BreakoutView | null
  /** Everyone in the meeting, every breakout room included (useRoomConnection `fullView`) */
  members: readonly Member[]
  /** Our own member id */
  you: string | null
  send: (message: ClientMessage) => void
  /** For tests: the clock and the shuffle */
  now?: () => number
  random?: () => number
}

/** The value of a 「移到」 select that means the main room */
const MAIN = 'main'

/**
 * 分組討論室 (L3, e10-t05; AC-10.4), a lazy chunk for a host or co-host (shared/roles.ts
 * `breakout`): before, how many rooms, their names, who goes where (spread at random, or by hand)
 * and for how long; while they are open, who is in which room with a 「移到」 per person, joining
 * any room ourselves and coming back, a broadcast to every room, and the recall (then 立即結束).
 * Only asks: the room decides everything (worker/room-breakout.ts).
 */
export default function BreakoutPanel({
  breakout,
  members,
  you,
  send,
  now = Date.now,
  random = Math.random,
}: BreakoutPanelProps) {
  // What had the focus can go (開始分組討論 once they open, 全部召回 once recalled): the focus stays
  // in the panel rather than falling to the page
  const panel = useRef<HTMLDivElement>(null)
  const focusInside = useRef(false)
  useLayoutEffect(() => {
    if (focusInside.current && document.activeElement === document.body) panel.current?.focus()
    focusInside.current = panel.current?.contains(document.activeElement) ?? false
  })
  return (
    <Panel ref={panel} tabIndex={-1}>
      {breakout ? (
        <Running breakout={breakout} members={members} you={you} send={send} now={now} />
      ) : (
        <Setup members={members} you={you} send={send} random={random} />
      )}
    </Panel>
  )
}

const byArrival = (a: Member, b: Member) => a.joinedAt - b.joinedAt

function Setup({
  members,
  you,
  send,
  random,
}: {
  members: readonly Member[]
  you: string | null
  send: (message: ClientMessage) => void
  random: () => number
}) {
  const [names, setNames] = useState<readonly string[]>(() => [
    strings.breakout.defaultName(1),
    strings.breakout.defaultName(2),
  ])
  const [mode, setMode] = useState<'auto' | 'manual'>('auto')
  /** By hand: member id → room index; anyone missing stays in the main room */
  const [manual, setManual] = useState<Readonly<Record<string, number>>>({})
  const [minutes, setMinutes] = useState('15')
  const [limited, setLimited] = useState(true)
  // Everyone but ourselves: we stay in the main room and join a room when we like
  const others = members.filter((member) => member.id !== you).sort(byArrival)
  const setCount = (count: number) =>
    setNames(
      Array.from(
        { length: count },
        (_, index) => names[index] ?? strings.breakout.defaultName(index + 1),
      ),
    )
  const assignment = (): Record<string, number> => {
    if (mode === 'auto') {
      const rooms = autoAssign(
        others.map((member) => member.id),
        names.length,
        random,
      )
      return Object.fromEntries(others.map((member, index) => [member.id, rooms[index]]))
    }
    // Only who is still here, in a room that is still listed
    return Object.fromEntries(
      others.flatMap((member) => {
        const index = manual[member.id]
        return index !== undefined && index < names.length ? [[member.id, index]] : []
      }),
    )
  }
  const length = limited ? Number(minutes) : null
  // What the room would take: the same check it does (the assignment never makes it fail)
  const valid = parseBreakoutOpen({ groups: [...names], assign: {}, minutes: length }) !== null
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const message = parseBreakoutOpen({ groups: [...names], assign: assignment(), minutes: length })
    if (message) send(message)
  }
  return (
    <Section as="form" noValidate aria-label={strings.breakout.setupLabel} onSubmit={submit}>
      <SelectField
        label={strings.breakout.count}
        value={names.length}
        onChange={(event) => setCount(Number(event.target.value))}
      >
        {Array.from({ length: MAX_BREAKOUT_GROUPS }, (_, index) => (
          <option key={index} value={index + 1}>
            {index + 1}
          </option>
        ))}
      </SelectField>
      {names.map((name, index) => (
        <TextField
          key={index}
          label={strings.breakout.name(index + 1)}
          value={name}
          maxLength={MAX_BREAKOUT_NAME_CHARS}
          aria-invalid={normalizeName(name, MAX_BREAKOUT_NAME_CHARS) === null}
          onChange={(event) =>
            setNames(names.map((other, at) => (at === index ? event.target.value : other)))
          }
        />
      ))}
      <Fieldset>
        <legend>{strings.breakout.assign}</legend>
        <Check>
          <input
            type="radio"
            name="breakout-assign"
            checked={mode === 'auto'}
            onChange={() => setMode('auto')}
          />
          {strings.breakout.auto}
        </Check>
        <Check>
          <input
            type="radio"
            name="breakout-assign"
            checked={mode === 'manual'}
            onChange={() => setMode('manual')}
          />
          {strings.breakout.manual}
        </Check>
      </Fieldset>
      {others.length === 0 ? (
        <Muted>{strings.breakout.noOthers}</Muted>
      ) : mode === 'auto' ? (
        <Muted>{strings.breakout.autoHint(others.length, names.length)}</Muted>
      ) : (
        <>
          <Muted>{strings.breakout.manualHint}</Muted>
          <People>
            {others.map((member) => {
              const index = manual[member.id]
              return (
                <Person key={member.id}>
                  <Who>{member.name}</Who>
                  <RoomSelect
                    aria-label={strings.breakout.assignOf(member.name)}
                    value={index !== undefined && index < names.length ? String(index) : MAIN}
                    onChange={(event) => {
                      const { [member.id]: _, ...rest } = manual
                      const value = event.target.value
                      setManual(value === MAIN ? rest : { ...rest, [member.id]: Number(value) })
                    }}
                  >
                    <option value={MAIN}>{strings.breakout.mainRoom}</option>
                    {names.map((name, at) => (
                      <option key={at} value={String(at)}>
                        {name.trim() || strings.breakout.defaultName(at + 1)}
                      </option>
                    ))}
                  </RoomSelect>
                </Person>
              )
            })}
          </People>
        </>
      )}
      <Row>
        <TextField
          label={strings.breakout.minutes}
          type="number"
          min={1}
          max={MAX_BREAKOUT_MINUTES}
          inputMode="numeric"
          value={minutes}
          disabled={!limited}
          aria-invalid={limited && !valid}
          onChange={(event) => setMinutes(event.target.value)}
        />
      </Row>
      <Check>
        <input
          type="checkbox"
          checked={!limited}
          onChange={(event) => setLimited(!event.target.checked)}
        />
        {strings.breakout.noLimit}
      </Check>
      <Muted>{strings.breakout.openEnds}</Muted>
      <Button type="submit" disabled={!valid}>
        {strings.breakout.open}
      </Button>
    </Section>
  )
}

function Running({
  breakout,
  members,
  you,
  send,
  now,
}: {
  breakout: BreakoutView
  members: readonly Member[]
  you: string | null
  send: (message: ClientMessage) => void
  now: () => number
}) {
  const { phase, ms } = useBreakoutRemaining(breakout, now)
  const [text, setText] = useState('')
  const broadcast = normalizeName(text, MAX_BROADCAST_CHARS)
  const mine = members.find((member) => member.id === you)?.group ?? null
  const rooms: { id: string | null; name: string }[] = [
    { id: null, name: strings.breakout.mainRoom },
    ...breakout.groups,
  ]
  const move = (memberId: string, group: string | null) =>
    send({ t: 'breakoutMove', memberId, group })
  return (
    <>
      <Status role="timer" aria-label={strings.breakout.timerLabel} $warn={phase === 'closing'}>
        {phase === 'closing'
          ? strings.breakout.closing(secondsOf(ms ?? 0))
          : ms === null
            ? strings.breakout.unlimited
            : strings.breakout.remaining(formatElapsed(secondsOf(ms) * 1000))}
      </Status>
      {rooms.map((room) => {
        const people = members
          .filter((member) => (member.group ?? null) === room.id)
          .sort(byArrival)
        const headingId = `breakout-room-${room.id ?? MAIN}`
        return (
          <Section key={room.id ?? MAIN} aria-labelledby={headingId}>
            <RoomHead>
              <h3 id={headingId}>{room.name}</h3>
              <Muted>{strings.breakout.roomCount(people.length)}</Muted>
              {you !== null && mine !== room.id && (
                <Button
                  variant="secondary"
                  aria-label={room.id === null ? undefined : strings.breakout.joinRoom(room.name)}
                  onClick={() => move(you, room.id)}
                >
                  {room.id === null ? strings.breakout.leave : strings.breakout.join}
                </Button>
              )}
            </RoomHead>
            {people.length === 0 ? (
              <Muted>{strings.breakout.empty}</Muted>
            ) : (
              <People aria-labelledby={headingId}>
                {people.map((member) => (
                  <Person key={member.id}>
                    <Who>
                      {member.name}
                      {member.id === you && <Tag>{strings.participants.you}</Tag>}
                    </Who>
                    {member.id !== you && (
                      <RoomSelect
                        aria-label={strings.breakout.moveOf(member.name)}
                        value={member.group ?? MAIN}
                        onChange={(event) =>
                          move(member.id, event.target.value === MAIN ? null : event.target.value)
                        }
                      >
                        {rooms.map((option) => (
                          <option key={option.id ?? MAIN} value={option.id ?? MAIN}>
                            {option.name}
                          </option>
                        ))}
                      </RoomSelect>
                    )}
                  </Person>
                ))}
              </People>
            )}
          </Section>
        )
      })}
      <Section
        as="form"
        noValidate
        aria-label={strings.breakout.broadcastLabel}
        onSubmit={(event: FormEvent) => {
          event.preventDefault()
          if (broadcast === null) return
          send({ t: 'breakoutBroadcast', text: broadcast })
          setText('')
        }}
      >
        <TextField
          label={strings.breakout.broadcastLabel}
          value={text}
          maxLength={MAX_BROADCAST_CHARS}
          onChange={(event) => setText(event.target.value)}
        />
        <Button type="submit" variant="secondary" disabled={broadcast === null}>
          {strings.breakout.broadcastSend}
        </Button>
      </Section>
      <Section>
        {phase === 'closing' ? (
          <Button variant="danger" onClick={() => send({ t: 'breakoutClose', now: true })}>
            {strings.breakout.endNow}
          </Button>
        ) : (
          <>
            <Muted>{strings.breakout.recallHint(BREAKOUT_RECALL_MS / 1000)}</Muted>
            <Button onClick={() => send({ t: 'breakoutClose', now: false })}>
              {strings.breakout.recall}
            </Button>
          </>
        )}
      </Section>
    </>
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

const Status = styled.p<{ $warn: boolean }>`
  margin: 0;
  color: ${({ $warn }) => ($warn ? color.warn : color.fg)};
  font-weight: 700;
  font-variant-numeric: tabular-nums;
`

const RoomHead = styled.div`
  display: flex;
  align-items: center;
  gap: ${space(2)};

  h3 {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  > button {
    margin-left: auto;
  }
`

const Fieldset = styled.fieldset`
  display: grid;
  gap: ${space(1)};
  margin: 0;
  padding: 0;
  border: none;

  legend {
    padding: 0;
    margin-bottom: ${space(1)};
    color: ${color.muted};
    font-size: ${fontSize.small};
  }
`

const Muted = styled.p`
  margin: 0;
  color: ${color.muted};
  font-size: ${fontSize.small};
`

const People = styled.ul`
  display: grid;
  gap: ${space(1)};
  margin: 0;
  padding: 0;
  list-style: none;
`

const Person = styled.li`
  display: flex;
  align-items: center;
  gap: ${space(2)};
  padding: ${space(1)} ${space(2)};
  border: 1px solid ${color.line};
  border-radius: ${radius.button};
`

const Who = styled.span`
  display: flex;
  flex: 1;
  align-items: center;
  gap: ${space(1)};
  min-width: 0;
  font-size: ${fontSize.small};
  overflow-wrap: anywhere;
`

const Tag = styled.span`
  flex: none;
  padding: 0 ${space(1)};
  border-radius: ${radius.pill};
  background: ${color.surface2};
  color: ${color.muted};
  font-size: ${fontSize.toolbarLabel};
`

const RoomSelect = styled(Select)`
  flex: none;
  width: auto;
  max-width: 50%;
  font-size: ${fontSize.small};
`

const Row = styled.div`
  display: flex;
  gap: ${space(2)};

  > label {
    flex: 1;
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
