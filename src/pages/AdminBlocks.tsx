import { useState, type FormEvent } from 'react'
import styled from 'styled-components'
import {
  BLOCK_HOURS,
  looksLikeIp,
  MAX_BLOCK_NOTE_CHARS,
  OFFENCE_KINDS,
  type AbuseSummary,
  type BlockHours,
  type BlockRequest,
} from '../../shared/abuse.ts'
import { Button } from '../components/Button.tsx'
import { SelectField, TextField } from '../components/Field.tsx'
import { formatDateTime, strings } from '../strings.ts'
import { color, font, fontSize, radius, space } from '../styles/tokens.ts'

/**
 * /admin's abuse section (I1, e11-t05): whether Turnstile and the pepper are on, the blocklist
 * with its expiry, a form to block an address, and the clients that recently hit a limit (each
 * can be blocked for a day). Addresses typed here go to the Worker, which keeps only their hash.
 * Part of the lazy /admin chunk; the page passes the calls in.
 */
export function AdminBlocks({
  abuse,
  onBlock,
  onUnblock,
}: {
  abuse: AbuseSummary | null
  onBlock: (request: BlockRequest) => Promise<boolean>
  onUnblock: (key: string) => Promise<boolean>
}) {
  const [ip, setIp] = useState('')
  const [hours, setHours] = useState<BlockHours>(24)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const text = strings.admin.abuse

  const run = async (call: () => Promise<boolean>) => {
    setBusy(true)
    setFailed(false)
    const ok = await call()
    setBusy(false)
    setFailed(!ok)
    return ok
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const address = ip.trim()
    if (!looksLikeIp(address)) {
      setFailed(true)
      return
    }
    if (await run(() => onBlock({ ip: address, hours, note: note.trim() || undefined }))) {
      setIp('')
      setNote('')
    }
  }

  return (
    <Section aria-labelledby="abuse">
      <h2 id="abuse">{text.title}</h2>
      {abuse === null ? (
        <p>{text.unavailable}</p>
      ) : (
        <>
          <Small>
            {text.turnstile(abuse.turnstile)} {text.pepper(abuse.pepper)}
          </Small>
          <Form onSubmit={onSubmit}>
            <TextField
              label={text.ipLabel}
              value={ip}
              onChange={(event) => setIp(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              inputMode="text"
            />
            <SelectField
              label={text.durationLabel}
              value={hours}
              onChange={(event) => setHours(Number(event.target.value) as BlockHours)}
            >
              {BLOCK_HOURS.map((h) => (
                <option key={h} value={h}>
                  {text.duration(h)}
                </option>
              ))}
            </SelectField>
            <TextField
              label={text.noteLabel}
              value={note}
              maxLength={MAX_BLOCK_NOTE_CHARS}
              onChange={(event) => setNote(event.target.value)}
            />
            <Button type="submit" disabled={busy || ip.trim() === ''}>
              {text.block}
            </Button>
          </Form>
          {failed && <ProblemText role="alert">{text.failed}</ProblemText>}
          <Small>{text.hashNote}</Small>

          <h3>{text.blocksTitle}</h3>
          {abuse.blocks.length === 0 ? (
            <p>{text.noBlocks}</p>
          ) : (
            <List>
              {abuse.blocks.map((entry) => (
                <li key={entry.key}>
                  <code>{entry.key}</code>
                  <span>
                    {text.until(formatDateTime(entry.until))}
                    {entry.note ? ` · ${entry.note}` : ''}
                  </span>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    aria-label={text.unblockLabel(entry.key)}
                    onClick={() => void run(() => onUnblock(entry.key))}
                  >
                    {text.unblock}
                  </Button>
                </li>
              ))}
            </List>
          )}

          <h3>{text.offendersTitle}</h3>
          {abuse.offenders.length === 0 ? (
            <p>{text.noOffenders}</p>
          ) : (
            <List>
              {abuse.offenders.map((offender) => (
                <li key={offender.key}>
                  <code>{offender.key}</code>
                  <span>
                    {OFFENCE_KINDS.filter((kind) => offender.counts[kind])
                      .map((kind) => `${text.kinds[kind]} ${offender.counts[kind]}`)
                      .join(strings.admin.listSeparator)}{' '}
                    · {formatDateTime(offender.last)}
                  </span>
                  <Button
                    variant="secondary"
                    disabled={busy || abuse.blocks.some((entry) => entry.key === offender.key)}
                    aria-label={text.blockKeyLabel(offender.key)}
                    onClick={() => void run(() => onBlock({ key: offender.key, hours: 24 }))}
                  >
                    {text.blockDay}
                  </Button>
                </li>
              ))}
            </List>
          )}
        </>
      )}
    </Section>
  )
}

const Section = styled.section`
  display: grid;
  gap: ${space(2)};

  h2 {
    margin: 0;
    font-size: ${fontSize.base};
  }
  h3 {
    margin: ${space(2)} 0 0;
    font-size: ${fontSize.small};
  }
  p {
    margin: 0;
  }
`

const Form = styled.form`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  align-items: end;
  gap: ${space(3)};
`

const List = styled.ul`
  display: grid;
  gap: ${space(2)};
  margin: 0;
  padding: 0;
  list-style: none;

  li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: ${space(2)} ${space(3)};
    padding: ${space(2)} ${space(3)};
    border: 1px solid ${color.line};
    border-radius: ${radius.button};
    background: ${color.surface};
    font-size: ${fontSize.small};
  }
  code {
    font-family: ${font.mono};
  }
  span {
    flex: 1 1 200px;
    color: ${color.muted};
  }
`

const ProblemText = styled.p`
  margin: 0;
  color: ${color.danger};
  font-size: ${fontSize.small};
`

const Small = styled.p`
  margin: 0;
  color: ${color.muted};
  font-size: ${fontSize.toolbarLabel};
`
