import { useEffect, useState, type FormEvent } from 'react'
import styled from 'styled-components'
import {
  CONNECTION_LAYERS,
  JOIN_FAILURES,
  RATING_SCORES,
  ratingsOf,
  ratingStats,
  type AdminSummary,
  type EventCounts,
} from '../../shared/telemetry.ts'
import { GB } from '../../shared/usage.ts'
import { blockClient, fetchAdminSummary, unblockClient } from '../api/admin.ts'
import { AdminBlocks } from './AdminBlocks.tsx'
import { Button } from '../components/Button.tsx'
import { TextField } from '../components/Field.tsx'
import { formatDateTime, formatDay, strings } from '../strings.ts'
import { color, font, fontSize, radius, space } from '../styles/tokens.ts'

type Phase = 'locked' | 'loading' | 'open'
type Problem = 'unauthorized' | 'notConfigured' | 'failed' | null

/**
 * /admin (e11-t03): the owner's dashboard skeleton, lazy-loaded (never in the home or room JS).
 * Locked until the owner types the password (the Worker secret ADMIN_TOKEN, DEPLOY.md §8); the
 * password stays in this page's memory only (a reload locks it again) and travels in a header.
 * Shows the telemetry counters (joins and why they failed, reconnects, rebuilds, the TURN ratio,
 * client errors, the after-leave ratings), the alert flags and the month's Realtime usage.
 */
export default function AdminPage() {
  const [draft, setDraft] = useState('')
  const [token, setToken] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('locked')
  const [problem, setProblem] = useState<Problem>(null)
  const [summary, setSummary] = useState<AdminSummary | null>(null)

  useEffect(() => {
    document.title = strings.admin.title
    return () => {
      document.title = strings.appName
    }
  }, [])

  const load = async (password: string) => {
    setPhase('loading')
    const result = await fetchAdminSummary(password)
    if (result.ok) {
      setToken(password)
      setSummary(result.summary)
      setProblem(null)
      setPhase('open')
      return
    }
    setProblem(result.reason)
    if (result.reason === 'failed' && token !== null) {
      setPhase('open')
      return
    }
    setToken(null)
    setSummary(null)
    setPhase('locked')
  }

  const onUnlock = (event: FormEvent) => {
    event.preventDefault()
    const password = draft.normalize('NFKC').trim()
    if (password === '') return
    void load(password)
    setDraft('')
  }

  if (phase !== 'open' || !summary) {
    return (
      <Page>
        <Locked onSubmit={onUnlock}>
          <h1>{strings.admin.lockedTitle}</h1>
          <p>{strings.admin.lockedBody}</p>
          <TextField
            label={strings.admin.tokenLabel}
            type="password"
            autoComplete="current-password"
            value={draft}
            // A Chinese IME left in full-width mode types Ａ-Ｚ／＋＝; the token is ASCII, so fold
            // them back (NFKC) instead of failing with a password that looks right
            onChange={(event) => setDraft(event.target.value.normalize('NFKC'))}
            disabled={phase === 'loading'}
          />
          {problem && <ProblemText role="alert">{problemText(problem)}</ProblemText>}
          <Button type="submit" block disabled={phase === 'loading' || draft.trim() === ''}>
            {phase === 'loading' ? strings.admin.unlocking : strings.admin.unlock}
          </Button>
          <Small>{strings.admin.privacy}</Small>
        </Locked>
      </Page>
    )
  }

  const { telemetry, usage } = summary
  return (
    <Page>
      <Dashboard>
        <Header>
          <h1>{strings.admin.title}</h1>
          <span>{strings.admin.updatedAt(formatDateTime(telemetry.now))}</span>
          <Actions>
            <Button variant="secondary" onClick={() => token && void load(token)}>
              {strings.admin.refresh}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setToken(null)
                setSummary(null)
                setPhase('locked')
              }}
            >
              {strings.admin.lock}
            </Button>
          </Actions>
        </Header>
        {problem && <ProblemText role="alert">{problemText(problem)}</ProblemText>}

        <Section aria-labelledby="alerts">
          <h2 id="alerts">{strings.admin.alertsTitle}</h2>
          {telemetry.alerts.length === 0 ? (
            <p>{strings.admin.noAlerts}</p>
          ) : (
            <AlertList role="alert">
              {telemetry.alerts.map((code) => (
                <li key={code}>{strings.admin.alerts[code]}</li>
              ))}
            </AlertList>
          )}
        </Section>

        <Section aria-labelledby="totals">
          <h2 id="totals">{strings.admin.totalsTitle}</h2>
          <Table>
            <thead>
              <tr>
                <th scope="col" />
                <th scope="col">{strings.admin.periods.last24h}</th>
                <th scope="col">{strings.admin.periods.last7d}</th>
              </tr>
            </thead>
            <tbody>
              {metricRows.map(({ label, value }) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  <td>{value(telemetry.last24h)}</td>
                  <td>{value(telemetry.last7d)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Section>

        <Section aria-labelledby="days">
          <h2 id="days">{strings.admin.daysTitle}</h2>
          {telemetry.days.length === 0 ? (
            <p>{strings.admin.none}</p>
          ) : (
            <Scroll>
              <Table>
                <thead>
                  <tr>
                    <th scope="col">{strings.admin.day}</th>
                    {dayColumns.map(({ label }) => (
                      <th key={label} scope="col">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {telemetry.days.map((day) => (
                    <tr key={day.day}>
                      <th scope="row">
                        <time dateTime={day.day}>{formatDay(day.day)}</time>
                      </th>
                      {dayColumns.map(({ label, value }) => (
                        <td key={label}>{value(day)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Scroll>
          )}
        </Section>

        <Section aria-labelledby="errors">
          <h2 id="errors">{strings.admin.recentErrors}</h2>
          {telemetry.recentErrors.length === 0 ? (
            <p>{strings.admin.noErrors}</p>
          ) : (
            <ErrorList>
              {telemetry.recentErrors.map((error) => (
                <li key={`${error.at}-${error.name}-${error.message}`}>
                  <code>
                    {error.name}: {error.message}
                  </code>
                  <Small>
                    {formatDateTime(error.at)} · {error.source || strings.admin.none} ·{' '}
                    {strings.admin.errorCount(error.count)}
                  </Small>
                </li>
              ))}
            </ErrorList>
          )}
        </Section>

        <Section aria-labelledby="usage">
          <h2 id="usage">{strings.admin.usageTitle}</h2>
          <p>
            {usage
              ? strings.admin.usage(
                  usage.month,
                  (usage.bytes / GB).toFixed(1),
                  strings.admin.usageStates[usage.state],
                )
              : strings.admin.none}
          </p>
          <Small>{strings.admin.analyticsEngine(summary.analyticsEngine)}</Small>
          <Small>{strings.admin.privacy}</Small>
        </Section>

        <AdminBlocks
          abuse={summary.abuse ?? null}
          onBlock={async (request) => {
            if (!token || !(await blockClient(token, request))) return false
            await load(token)
            return true
          }}
          onUnblock={async (key) => {
            if (!token || !(await unblockClient(token, key))) return false
            await load(token)
            return true
          }}
        />
      </Dashboard>
    </Page>
  )
}

function problemText(problem: Exclude<Problem, null>): string {
  switch (problem) {
    case 'unauthorized':
      return strings.admin.wrongToken
    case 'notConfigured':
      return strings.admin.notConfigured
    case 'failed':
      return strings.admin.loadFailed
  }
}

const failed = (counts: EventCounts) =>
  Object.values(counts.joinFail).reduce((total, n) => total + (n ?? 0), 0)

const ratio = (part: number, whole: number) =>
  whole === 0 ? strings.admin.none : strings.admin.ratio(part, whole)

const listed = <K extends string>(
  keys: readonly K[],
  counts: Partial<Record<K, number>>,
  names: Record<K, string>,
) => {
  const parts = keys
    .filter((key) => (counts[key] ?? 0) > 0)
    .map((key) => `${names[key]} ${counts[key]}`)
  return parts.length === 0 ? strings.admin.none : parts.join(strings.admin.listSeparator)
}

/** The average score with how many gave one, or — */
const ratingAverage = (counts: EventCounts) => {
  const { count, average } = ratingStats(counts)
  return average === null
    ? strings.admin.none
    : strings.admin.ratingAverage(average.toFixed(1), count)
}

/** Highest score first, only the scores someone gave */
const ratingDistribution = (counts: EventCounts) => {
  const byScore = ratingsOf(counts)
  const parts = [...RATING_SCORES]
    .reverse()
    .filter((score) => byScore[score] > 0)
    .map((score) => strings.admin.ratingScore(score, byScore[score]))
  return parts.length === 0 ? strings.admin.none : parts.join(strings.admin.listSeparator)
}

const metricRows: { label: string; value: (counts: EventCounts) => string }[] = [
  { label: strings.admin.metrics.joins, value: (c) => String(c.joinOk + failed(c)) },
  { label: strings.admin.metrics.joinRate, value: (c) => ratio(c.joinOk, c.joinOk + failed(c)) },
  {
    label: strings.admin.metrics.joinFailures,
    value: (c) => listed(JOIN_FAILURES, c.joinFail, strings.admin.reasons),
  },
  {
    label: strings.admin.metrics.reconnects,
    value: (c) => listed(CONNECTION_LAYERS, c.reconnect, strings.admin.layers),
  },
  { label: strings.admin.metrics.rebuilds, value: (c) => String(c.rebuild) },
  { label: strings.admin.metrics.relayRatio, value: (c) => ratio(c.relayed, c.media) },
  { label: strings.admin.metrics.errors, value: (c) => String(c.errors) },
  { label: strings.admin.metrics.rating, value: ratingAverage },
  { label: strings.admin.metrics.ratingDistribution, value: ratingDistribution },
]

const dayColumns: { label: string; value: (counts: EventCounts) => string }[] = [
  { label: strings.admin.metrics.joins, value: (c) => String(c.joinOk + failed(c)) },
  {
    label: strings.admin.metrics.joinRate,
    value: (c) => {
      const total = c.joinOk + failed(c)
      return total === 0 ? strings.admin.none : strings.admin.percent(c.joinOk / total)
    },
  },
  {
    label: strings.admin.metrics.reconnects,
    value: (c) => String(Object.values(c.reconnect).reduce((t, n) => t + (n ?? 0), 0)),
  },
  { label: strings.admin.metrics.rebuilds, value: (c) => String(c.rebuild) },
  {
    label: strings.admin.metrics.relayRatio,
    value: (c) => (c.media === 0 ? strings.admin.none : strings.admin.percent(c.relayed / c.media)),
  },
  { label: strings.admin.metrics.errors, value: (c) => String(c.errors) },
  { label: strings.admin.metrics.rating, value: ratingAverage },
]

const Page = styled.main`
  min-height: 100dvh;
  padding: ${space(6)} ${space(4)};
  font-family: ${font.current};
  background: ${color.bg};
  color: ${color.fg};
`

const Locked = styled.form`
  display: grid;
  gap: ${space(4)};
  max-width: 400px;
  margin: 10vh auto 0;
  padding: ${space(6)};
  border: 1px solid ${color.line};
  border-radius: ${radius.panel};
  background: ${color.surface};

  h1 {
    margin: 0;
    font-size: 22px;
  }
  p {
    margin: 0;
    color: ${color.muted};
    font-size: ${fontSize.small};
    line-height: 1.6;
  }
`

const Dashboard = styled.div`
  display: grid;
  gap: ${space(6)};
  max-width: 960px;
  margin: 0 auto;
`

const Header = styled.header`
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: ${space(3)};

  h1 {
    margin: 0;
    font-size: 24px;
  }
  span {
    color: ${color.muted};
    font-size: ${fontSize.small};
  }
`

const Actions = styled.div`
  display: flex;
  gap: ${space(2)};
  margin-left: auto;
`

const Section = styled.section`
  display: grid;
  gap: ${space(2)};

  h2 {
    margin: 0;
    font-size: ${fontSize.base};
  }
  p {
    margin: 0;
  }
`

const AlertList = styled.ul`
  margin: 0;
  padding: ${space(3)} ${space(3)} ${space(3)} ${space(8)};
  border: 1px solid ${color.danger};
  border-radius: ${radius.button};
  background: ${color.surface};
  color: ${color.danger};
`

const Scroll = styled.div`
  overflow-x: auto;
`

const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: ${fontSize.small};
  font-variant-numeric: tabular-nums;

  th,
  td {
    padding: ${space(2)} ${space(3)};
    border-bottom: 1px solid ${color.line};
    text-align: left;
    white-space: nowrap;
  }
  thead th {
    color: ${color.muted};
    font-weight: 500;
  }
  tbody th {
    font-weight: 500;
  }
`

const ErrorList = styled.ol`
  display: grid;
  gap: ${space(2)};
  margin: 0;
  padding: 0;
  list-style: none;

  li {
    display: grid;
    gap: ${space(1)};
    padding: ${space(3)};
    border: 1px solid ${color.line};
    border-radius: ${radius.button};
    background: ${color.surface};
  }
  code {
    font-family: ${font.mono};
    font-size: ${fontSize.small};
    overflow-wrap: anywhere;
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
