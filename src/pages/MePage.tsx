import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  MAX_PERSISTENT_ROOMS,
  type MeResponse,
  type PasskeyInfo,
  type PersistentRoomInfo,
  type SessionInfo,
} from '../../shared/account.ts'
import { BACKUP_RETENTION_DAYS } from '../../shared/file-limits.ts'
import { MAX_NAME_CHARS, MAX_ROOM_NAME_CHARS, normalizeName } from '../../shared/protocol.ts'
import { normalizePassword } from '../../shared/password.ts'
import { normalizeSlug, slugProblem, SLUG_MAX_CHARS } from '../../shared/slug.ts'
import { PasskeyCancelled } from '../account/webauthn.ts'
import {
  AccountApiError,
  addPasskey,
  createPersistentRoom,
  deleteAccount,
  deletePersistentRoom,
  fetchMe,
  removePasskey,
  renameAccount,
  signIn,
  signOut,
  signOutOthers,
  signOutSession,
  signUp,
  updatePersistentRoom,
} from '../api/account.ts'
import { Button } from '../components/Button.tsx'
import { ConfirmDialog } from '../components/ConfirmDialog.tsx'
import { TextField } from '../components/Field.tsx'
import { Logo } from '../components/Logo.tsx'
import { canCopy, canUsePasskeys } from '../media/capabilities.ts'
import { formatDateTime, getLocale, strings } from '../strings.ts'
import { turnstileToken } from '../turnstile.ts'
import {
  Actions,
  ButtonLink,
  Card,
  Challenge,
  Check,
  Content,
  Form,
  Header,
  Item,
  ItemHead,
  List,
  Message,
  Mono,
  Muted,
  Page,
  Row,
  Small,
  Top,
} from './accountStyles.tsx'
import { MeetingsCard } from './MeetingsCard.tsx'

/** What the page says after an action: an error (role alert) or a confirmation (role status) */
type Notice = { tone: 'error' | 'ok'; text: string } | null

function errorText(error: unknown): string {
  const text = strings.account.errors
  if (error instanceof PasskeyCancelled) return text.cancelled
  if (!(error instanceof AccountApiError)) return text.failed
  if (error.code === 'rate_limited') return text.rate_limited(Math.max(1, Math.ceil(error.retryAfter / 60)))
  if (error.code === 'slug_invalid' && error.slugProblem) {
    return strings.account.slugProblems[error.slugProblem]
  }
  if (error.code === 'meeting_invalid' && error.meetingProblem) {
    return strings.meetings.problems[error.meetingProblem]
  }
  return text[error.code]
}

type Phase = { at: 'loading' } | { at: 'signedOut' } | { at: 'signedIn'; me: MeResponse }

/**
 * /me (I2, e1-t12): accounts are optional, passkeys only. Signed out: sign in, or make an account
 * (a display name and a passkey on this device). Signed in: the name, personal persistent rooms
 * (e1-t13), scheduled meetings (I3, e1-t14), passkeys, signed-in browsers and deleting everything. Lazy-loaded: none of this, nor
 * the WebAuthn code, is in the home page's JS. Every rule is the Worker's (worker/accounts.ts).
 */
export default function MePage() {
  const [phase, setPhase] = useState<Phase>({ at: 'loading' })
  const [notice, setNotice] = useState<Notice>(null)
  const [supported] = useState(canUsePasskeys)

  const load = useCallback(
    () =>
      fetchMe().then(
        (me) => setPhase(me ? { at: 'signedIn', me } : { at: 'signedOut' }),
        (error: unknown) => {
          setPhase({ at: 'signedOut' })
          setNotice({ tone: 'error', text: errorText(error) })
        },
      ),
    [],
  )

  useEffect(() => {
    document.title = `${strings.account.title} · ${strings.appName}`
    return () => {
      document.title = strings.appName
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  /** Runs an action; its failure is the page's notice, its success `ok` (if any) */
  const run = useCallback(
    async (action: () => Promise<unknown>, ok?: string, reload = true) => {
      setNotice(null)
      try {
        await action()
        if (ok) setNotice({ tone: 'ok', text: ok })
        if (reload) await load()
        return true
      } catch (error) {
        setNotice({ tone: 'error', text: errorText(error) })
        if (error instanceof AccountApiError && error.code === 'signed_out') setPhase({ at: 'signedOut' })
        return false
      }
    },
    [load],
  )

  return (
    <Page>
      <Top>
        <Logo size={28} />
        <Link to="/">{strings.account.back}</Link>
      </Top>
      <Content>
        <h1>{strings.account.title}</h1>
        <NoticeArea notice={notice} />
        {phase.at === 'loading' && <p role="status">{strings.account.loading}</p>}
        {phase.at === 'signedOut' &&
          (supported ? (
            <SignedOut run={run} />
          ) : (
            <>
              <Muted>{strings.account.intro}</Muted>
              <p role="alert">{strings.account.noPasskeys}</p>
            </>
          ))}
        {phase.at === 'signedIn' && (
          <SignedIn me={phase.me} run={run} onSignedOut={() => setPhase({ at: 'signedOut' })} />
        )}
        <Small>
          <Link to="/privacy">{strings.privacy.link}</Link>
        </Small>
      </Content>
    </Page>
  )
}

type Run = (action: () => Promise<unknown>, ok?: string, reload?: boolean) => Promise<boolean>

function NoticeArea({ notice }: { notice: Notice }) {
  // Always on the page (RULES.md §1 無障礙): a region that appears with its text is often not read
  return (
    <div>
      <Message role="alert" $tone="error">
        {notice?.tone === 'error' ? notice.text : ''}
      </Message>
      <Message role="status" $tone="ok">
        {notice?.tone === 'ok' ? notice.text : ''}
      </Message>
    </div>
  )
}

function SignedOut({ run }: { run: Run }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState<'in' | 'up' | null>(null)
  // Turnstile's widget, when it needs the person (most of the time it stays empty)
  const challenge = useRef<HTMLDivElement>(null)
  const valid = normalizeName(name) !== null

  const onSignIn = async () => {
    setBusy('in')
    await run(signIn)
    setBusy(null)
  }

  const onSignUp = async (event: FormEvent) => {
    event.preventDefault()
    const clean = normalizeName(name)
    if (!clean) return
    setBusy('up')
    await run(async () => {
      try {
        await signUp(clean)
      } catch (error) {
        if (!(error instanceof AccountApiError) || error.code !== 'turnstile_required' || !error.siteKey) {
          throw error
        }
        const token = await turnstileToken(challenge.current!, error.siteKey, getLocale().toLowerCase())
        await signUp(clean, token)
      }
    })
    setBusy(null)
  }

  return (
    <>
      <Muted>{strings.account.intro}</Muted>
      <Card aria-labelledby="sign-in">
        <h2 id="sign-in">{strings.account.signInTitle}</h2>
        <Button onClick={onSignIn} disabled={busy !== null}>
          {busy === 'in' ? strings.account.signingIn : strings.account.signIn}
        </Button>
      </Card>
      <Card as="form" aria-labelledby="sign-up" onSubmit={onSignUp} noValidate>
        <h2 id="sign-up">{strings.account.signUpTitle}</h2>
        <Muted>{strings.account.signUpBody}</Muted>
        <TextField
          label={strings.account.nameLabel}
          value={name}
          maxLength={MAX_NAME_CHARS * 2}
          autoComplete="nickname"
          onChange={(event) => setName(event.target.value)}
        />
        <Challenge ref={challenge} />
        <Button type="submit" variant="secondary" disabled={busy !== null || !valid}>
          {busy === 'up' ? strings.account.signingUp : strings.account.signUp}
        </Button>
      </Card>
    </>
  )
}

function SignedIn({ me, run, onSignedOut }: { me: MeResponse; run: Run; onSignedOut: () => void }) {
  const [confirm, setConfirm] = useState<{
    title: string
    body: string
    label: string
    action: () => void
  } | null>(null)
  const ask = (title: string, body: string, label: string, action: () => void) =>
    setConfirm({ title, body, label, action })

  return (
    <>
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.label}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null)
            confirm.action()
          }}
        />
      )}
      <Header>
        <span>{strings.account.signedInAs(me.account.name)}</span>
        <Button
          variant="secondary"
          onClick={() => void run(signOut, undefined, false).then((ok) => ok && onSignedOut())}
        >
          {strings.account.signOut}
        </Button>
      </Header>
      <NameCard name={me.account.name} run={run} />
      <RoomsCard rooms={me.rooms} run={run} ask={ask} />
      <MeetingsCard meetings={me.meetings} rooms={me.rooms} organizer={me.account.name} run={run} ask={ask} />
      <PasskeysCard passkeys={me.passkeys} run={run} ask={ask} />
      <SessionsCard sessions={me.sessions} run={run} />
      <Card aria-labelledby="delete-account">
        <h2 id="delete-account">{strings.account.deleteTitle}</h2>
        <Muted>{strings.account.deleteBody(BACKUP_RETENTION_DAYS)}</Muted>
        <div>
          <Button
            variant="danger"
            onClick={() =>
              ask(
                strings.account.deleteConfirmTitle,
                strings.account.deleteConfirmBody,
                strings.account.deleteAccount,
                () => void run(deleteAccount, undefined, false).then((ok) => ok && onSignedOut()),
              )
            }
          >
            {strings.account.deleteAccount}
          </Button>
        </div>
      </Card>
    </>
  )
}

type Ask = (title: string, body: string, label: string, action: () => void) => void

function NameCard({ name, run }: { name: string; run: Run }) {
  const [draft, setDraft] = useState(name)
  const clean = normalizeName(draft)
  return (
    <Card
      as="form"
      aria-labelledby="account-name"
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        if (clean) void run(() => renameAccount(clean), strings.account.saved)
      }}
    >
      <h2 id="account-name">{strings.account.nameTitle}</h2>
      <Row>
        <TextField
          label={strings.account.nameLabel}
          value={draft}
          maxLength={MAX_NAME_CHARS * 2}
          autoComplete="nickname"
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" variant="secondary" disabled={!clean || clean === name}>
          {strings.account.save}
        </Button>
      </Row>
      <Muted>{strings.account.nameHint}</Muted>
    </Card>
  )
}

const roomLink = (slug: string) => `${location.origin}/r/${slug}`

function RoomsCard({ rooms, run, ask }: { rooms: PersistentRoomInfo[]; run: Run; ask: Ask }) {
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const normalized = normalizeSlug(slug)
  const problem = slug.trim() === '' ? null : slugProblem(normalized)
  const full = rooms.length >= MAX_PERSISTENT_ROOMS

  const onCreate = async (event: FormEvent) => {
    event.preventDefault()
    if (slug.trim() === '' || problem) return
    if (await run(() => createPersistentRoom(normalized, name.trim()))) {
      setSlug('')
      setName('')
    }
  }

  return (
    <Card aria-labelledby="rooms">
      <h2 id="rooms">{strings.account.roomsTitle}</h2>
      <Muted>{strings.account.roomsBody(MAX_PERSISTENT_ROOMS)}</Muted>
      {rooms.length === 0 ? (
        <p>{strings.account.noRooms}</p>
      ) : (
        <List>
          {rooms.map((room) => (
            <RoomItem key={room.slug} room={room} run={run} ask={ask} />
          ))}
        </List>
      )}
      {!full && (
        <Form onSubmit={onCreate} noValidate aria-labelledby="new-room">
          <h3 id="new-room">{strings.account.createRoom}</h3>
          <TextField
            label={strings.account.slugLabel}
            value={slug}
            maxLength={SLUG_MAX_CHARS + 8}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={problem !== null}
            aria-describedby="slug-hint"
            onChange={(event) => setSlug(event.target.value)}
          />
          <Muted id="slug-hint">
            {problem ? strings.account.slugProblems[problem] : strings.account.slugHint}
            {slug.trim() !== '' && !problem && <Mono> {roomLink(normalized)}</Mono>}
          </Muted>
          <TextField
            label={strings.account.roomNameLabel}
            value={name}
            maxLength={MAX_ROOM_NAME_CHARS * 2}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
          <div>
            <Button type="submit" disabled={slug.trim() === '' || problem !== null}>
              {strings.account.createRoom}
            </Button>
          </div>
        </Form>
      )}
    </Card>
  )
}

function RoomItem({ room, run, ask }: { room: PersistentRoomInfo; run: Run; ask: Ask }) {
  const [editing, setEditing] = useState(false)
  const [copyable] = useState(canCopy)
  const link = roomLink(room.slug)
  const flags = [
    room.waitingRoom && strings.account.waitingRoom,
    room.locked && strings.account.locked,
    room.password && strings.account.passwordSet,
    room.startMuted && strings.account.startMuted,
    !room.allowAnnotation && strings.account.noAnnotation,
    !room.allowRecording && strings.account.noRecording,
    !room.allowControl && strings.account.noControl,
    room.memberCount > 0 && strings.account.roomPeople(room.memberCount),
  ].filter(Boolean)
  return (
    <Item>
      <ItemHead>
        <b>{room.name ?? room.slug}</b>
        <Mono>{link}</Mono>
        {flags.length > 0 && <Small>{flags.join(' · ')}</Small>}
      </ItemHead>
      <Actions>
        <ButtonLink to={`/r/${room.slug}`}>{strings.account.openRoom}</ButtonLink>
        {copyable && (
          <Button
            variant="secondary"
            onClick={() => void run(() => navigator.clipboard.writeText(link), strings.account.copied, false)}
          >
            {strings.account.copyLink}
          </Button>
        )}
        <Button
          variant="secondary"
          aria-expanded={editing}
          aria-label={strings.account.editRoomLabel(room.slug)}
          onClick={() => setEditing((on) => !on)}
        >
          {strings.account.editRoom}
        </Button>
        <Button
          variant="ghost"
          aria-label={strings.account.deleteRoomLabel(room.slug)}
          onClick={() =>
            ask(
              strings.account.deleteRoomTitle,
              strings.account.deleteRoomBody(room.slug),
              strings.account.deleteRoom,
              () => void run(() => deletePersistentRoom(room.slug)),
            )
          }
        >
          {strings.account.deleteRoom}
        </Button>
      </Actions>
      {editing && <RoomSettingsForm room={room} run={run} onDone={() => setEditing(false)} />}
    </Item>
  )
}

function RoomSettingsForm({
  room,
  run,
  onDone,
}: {
  room: PersistentRoomInfo
  run: Run
  onDone: () => void
}) {
  const [name, setName] = useState(room.name ?? '')
  const [waitingRoom, setWaitingRoom] = useState(room.waitingRoom)
  const [locked, setLocked] = useState(room.locked)
  const [startMuted, setStartMuted] = useState(room.startMuted)
  const [allowAnnotation, setAllowAnnotation] = useState(room.allowAnnotation)
  const [allowRecording, setAllowRecording] = useState(room.allowRecording)
  const [allowControl, setAllowControl] = useState(room.allowControl)
  const [password, setPassword] = useState('')
  const passwordValue = password.trim() === '' ? null : normalizePassword(password)
  const passwordBad = password.trim() !== '' && passwordValue === null

  const save = async (clearPassword = false) => {
    const ok = await run(
      () =>
        updatePersistentRoom(room.slug, {
          name: name.trim() === '' ? null : name,
          waitingRoom,
          locked,
          startMuted,
          allowAnnotation,
          allowRecording,
          allowControl,
          ...(clearPassword ? { password: null } : passwordValue ? { password: passwordValue } : {}),
        }),
      strings.account.saved,
    )
    if (ok) onDone()
  }

  return (
    <Form
      aria-label={strings.account.editRoomLabel(room.slug)}
      onSubmit={(event) => {
        event.preventDefault()
        if (!passwordBad) void save()
      }}
      noValidate
    >
      <TextField
        label={strings.account.roomNameLabel}
        value={name}
        maxLength={MAX_ROOM_NAME_CHARS * 2}
        onChange={(event) => setName(event.target.value)}
      />
      <Check>
        <input type="checkbox" checked={waitingRoom} onChange={(e) => setWaitingRoom(e.target.checked)} />
        {strings.account.waitingRoom}
      </Check>
      <Check>
        <input type="checkbox" checked={locked} onChange={(e) => setLocked(e.target.checked)} />
        {strings.account.locked}
      </Check>
      <Check>
        <input type="checkbox" checked={startMuted} onChange={(e) => setStartMuted(e.target.checked)} />
        {strings.account.startMuted}
      </Check>
      <Check>
        <input
          type="checkbox"
          checked={allowAnnotation}
          onChange={(e) => setAllowAnnotation(e.target.checked)}
        />
        {strings.account.allowAnnotation}
      </Check>
      <Check>
        <input
          type="checkbox"
          checked={allowRecording}
          onChange={(e) => setAllowRecording(e.target.checked)}
        />
        {strings.account.allowRecording}
      </Check>
      <Check>
        <input
          type="checkbox"
          checked={allowControl}
          onChange={(e) => setAllowControl(e.target.checked)}
        />
        {strings.account.allowControl}
      </Check>
      <Small>{strings.account.settingsHint}</Small>
      <TextField
        label={strings.account.newPassword}
        type="password"
        autoComplete="new-password"
        value={password}
        aria-invalid={passwordBad}
        onChange={(event) => setPassword(event.target.value)}
      />
      <Actions>
        <Button type="submit" disabled={passwordBad}>
          {strings.account.saveRoom}
        </Button>
        {room.password && (
          <Button variant="secondary" onClick={() => void save(true)}>
            {strings.account.clearPassword}
          </Button>
        )}
      </Actions>
    </Form>
  )
}

function PasskeysCard({ passkeys, run, ask }: { passkeys: PasskeyInfo[]; run: Run; ask: Ask }) {
  const only = passkeys.length <= 1
  return (
    <Card aria-labelledby="passkeys">
      <h2 id="passkeys">{strings.account.passkeysTitle}</h2>
      <Muted>{strings.account.passkeysBody}</Muted>
      <List>
        {passkeys.map((passkey) => {
          const label = passkey.provider ? strings.account.providers[passkey.provider] : strings.account.passkey
          const created = formatDateTime(passkey.createdAt)
          return (
            <Item key={passkey.id}>
              <ItemHead>
                <b>{label}</b>
                <Small>
                  {strings.account.createdAt(created)}
                  {' · '}
                  {passkey.lastUsedAt ? strings.account.lastUsed(formatDateTime(passkey.lastUsedAt)) : strings.account.neverUsed}
                  {passkey.backedUp && ` · ${strings.account.synced}`}
                </Small>
              </ItemHead>
              <Actions>
                <Button
                  variant="ghost"
                  disabled={only}
                  title={only ? strings.account.lastPasskey : undefined}
                  aria-label={strings.account.removePasskeyLabel(label, created)}
                  onClick={() =>
                    ask(
                      strings.account.removePasskeyTitle,
                      strings.account.removePasskeyBody,
                      strings.account.removePasskey,
                      () => void run(() => removePasskey(passkey.id)),
                    )
                  }
                >
                  {strings.account.removePasskey}
                </Button>
              </Actions>
            </Item>
          )
        })}
      </List>
      {only && <Small>{strings.account.lastPasskey}</Small>}
      <div>
        <Button variant="secondary" onClick={() => void run(addPasskey, strings.account.saved)}>
          {strings.account.addPasskey}
        </Button>
      </div>
    </Card>
  )
}

function SessionsCard({ sessions, run }: { sessions: SessionInfo[]; run: Run }) {
  const others = sessions.filter((session) => !session.current).length
  return (
    <Card aria-labelledby="sessions">
      <h2 id="sessions">{strings.account.sessionsTitle}</h2>
      <List>
        {sessions.map((session) => {
          const since = formatDateTime(session.createdAt)
          return (
            <Item key={session.id}>
              <ItemHead>
                <b>{session.current ? strings.account.thisBrowser : strings.account.signedInAt(since)}</b>
                <Small>
                  {session.current && `${strings.account.signedInAt(since)} · `}
                  {strings.account.seenAt(formatDateTime(session.lastSeenAt))}
                </Small>
              </ItemHead>
              {!session.current && (
                <Actions>
                  <Button
                    variant="ghost"
                    aria-label={strings.account.signOutSessionLabel(since)}
                    onClick={() => void run(() => signOutSession(session.id))}
                  >
                    {strings.account.signOutSession}
                  </Button>
                </Actions>
              )}
            </Item>
          )
        })}
      </List>
      {others > 0 && (
        <div>
          <Button
            variant="secondary"
            onClick={() =>
              void run(async () => {
                const count = await signOutOthers()
                return count
              }, strings.account.signedOutOthers(others))
            }
          >
            {strings.account.signOutOthers}
          </Button>
        </div>
      )}
    </Card>
  )
}
