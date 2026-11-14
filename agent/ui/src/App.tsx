// The agent's window: the join form, connecting, the local confirmation (§5.1 step 4), the room
// with the 「分享我的螢幕」 switch. What phase it is in is Rust's (session.rs); text is i18n.ts's.
// N5 (e9-t08, e9-t09): the permission guide (macOS, Linux without X11) above the form and the
// room, 「換一個螢幕」 while sharing, and 「你分享的是哪一個螢幕？」 when several screens fit.
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { CONSENT_DIALOG_ARM_MS } from '../../../shared/control.ts'
import { ControlLine, useControlView } from './control.tsx'
import type { AgentController, AgentView } from './controller.ts'
import { defaultDevice } from './deviceName.ts'
import { text } from './i18n.ts'
import type { PermissionKind, Permissions } from './native.ts'

export function App({ controller }: { controller: AgentController }) {
  const view = useSyncExternalStore(controller.subscribe, controller.getView)
  // Back from System Settings: read the permissions again (N5)
  useEffect(() => {
    const again = () => void controller.refreshPermissions()
    window.addEventListener('focus', again)
    return () => window.removeEventListener('focus', again)
  }, [controller])
  return (
    <main className="agent">
      <header className="agent-header">
        <img className="agent-logo" src="/logo.svg" alt="" width={28} height={28} />
        <h1>{text.appName}</h1>
      </header>
      {view.permissions && (
        <PermissionGuide
          permissions={view.permissions}
          onOpen={(kind) => void controller.requestPermission(kind)}
        />
      )}
      <Screen view={view} controller={controller} />
    </main>
  )
}

const PERMISSION_KINDS: readonly PermissionKind[] = ['screen', 'accessibility', 'inputMonitoring']

/**
 * What the OS must allow before control works here (N5, AC-9.5, T-24): shown while anything is
 * missing; each missing macOS permission has 「打開設定」 (macOS asks, its page opens). Nothing is
 * changed without the person's press, and the OS decides.
 */
export function PermissionGuide({
  permissions,
  onOpen,
}: {
  permissions: Permissions
  onOpen: (kind: PermissionKind) => void
}) {
  const missing = PERMISSION_KINDS.filter((kind) => permissions[kind] === 'missing')
  if (permissions.x11 === 'missing') {
    return (
      <section className="agent-permissions" aria-labelledby="permissions-title">
        <h2 id="permissions-title">{text.permissions.title}</h2>
        <p className="agent-problem">{text.permissions.noX11}</p>
      </section>
    )
  }
  if (missing.length === 0) return null
  return (
    <section className="agent-permissions" aria-labelledby="permissions-title">
      <h2 id="permissions-title">{text.permissions.title}</h2>
      <p className="agent-muted">{text.permissions.intro}</p>
      {PERMISSION_KINDS.filter((kind) => permissions[kind] !== 'notNeeded').map((kind) => (
        <div key={kind} className="agent-permission">
          <span>{text.permissions[kind]}</span>
          {permissions[kind] === 'missing' ? (
            <button type="button" onClick={() => onOpen(kind)}>
              {text.permissions.open}
            </button>
          ) : (
            <span className="agent-muted">{text.permissions.granted}</span>
          )}
        </div>
      ))}
      <small className="agent-muted">{text.permissions.afterUpdate}</small>
    </section>
  )
}

function Screen({ view, controller }: { view: AgentView; controller: AgentController }) {
  switch (view.phase.phase) {
    case 'idle':
      return <JoinForm view={view} controller={controller} />
    case 'connecting':
      return (
        <p className="agent-status" role="status">
          {text.connecting}
        </p>
      )
    case 'confirming':
      return (
        <Confirm
          ownerName={view.phase.ownerName}
          roomName={text.roomName(view.phase.roomName, view.phase.createdBy)}
          controller={controller}
        />
      )
    case 'inRoom':
      return (
        <InRoom
          view={view}
          ownerName={view.phase.ownerName}
          roomName={text.roomName(view.phase.roomName, view.phase.createdBy)}
          sharing={view.phase.sharing}
          controller={controller}
        />
      )
  }
}

function JoinForm({ view, controller }: { view: AgentView; controller: AgentController }) {
  const [link, setLink] = useState('')
  const [pairing, setPairing] = useState('')
  const [device, setDevice] = useState<string | null>(null)
  const shownDevice = device ?? defaultDevice(view.info?.device ?? '')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    void controller.join(link, pairing, shownDevice)
  }
  return (
    <form className="agent-form" onSubmit={submit} noValidate>
      <h2>{text.join.title}</h2>
      <p className="agent-muted">{text.join.intro}</p>
      <label>
        <span>{text.join.link}</span>
        <input
          value={link}
          onChange={(event) => setLink(event.target.value)}
          placeholder={text.join.linkPlaceholder}
          autoComplete="off"
          spellCheck={false}
          required
        />
      </label>
      <label>
        <span>{text.join.pairing}</span>
        <input
          value={pairing}
          onChange={(event) => setPairing(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          maxLength={16}
          className="agent-code"
          required
        />
        <small className="agent-muted">{text.join.pairingHint}</small>
      </label>
      <label>
        <span>{text.join.device}</span>
        <input
          value={shownDevice}
          onChange={(event) => setDevice(event.target.value)}
          autoComplete="off"
          maxLength={60}
          required
        />
        <small className="agent-muted">{text.join.deviceHint}</small>
      </label>
      <p className="agent-problem" role="alert">
        {view.problem ? text.problems[view.problem] : ''}
      </p>
      <button type="submit" className="agent-primary" disabled={!view.info}>
        {text.join.submit}
      </button>
    </form>
  )
}

/**
 * Before anything is published: who issued the code and which room, and that everyone there will
 * see the screen. Both buttons do nothing for CONSENT_DIALOG_ARM_MS (Rust checks it too), and the
 * focus starts on 取消.
 */
function Confirm({
  ownerName,
  roomName,
  controller,
}: {
  ownerName: string
  roomName: string
  controller: AgentController
}) {
  const [armed, setArmed] = useState(false)
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), CONSENT_DIALOG_ARM_MS)
    return () => clearTimeout(timer)
  }, [])
  useEffect(() => {
    if (armed) cancel.current?.focus()
  }, [armed])
  return (
    <section className="agent-confirm" aria-labelledby="confirm-title">
      <h2 id="confirm-title">{text.confirm.title}</h2>
      <p className="agent-question">{text.confirm.question(ownerName, roomName)}</p>
      <p className="agent-muted">{text.confirm.warning}</p>
      <div className="agent-actions">
        <button
          ref={cancel}
          type="button"
          disabled={!armed}
          onClick={() => void controller.confirm(false)}
        >
          {text.confirm.cancel}
        </button>
        <button
          type="button"
          className="agent-primary"
          disabled={!armed}
          onClick={() => void controller.confirm(true)}
        >
          {text.confirm.join}
        </button>
      </div>
    </section>
  )
}

function InRoom({
  view,
  ownerName,
  roomName,
  sharing,
  controller,
}: {
  view: AgentView
  ownerName: string
  roomName: string
  sharing: boolean
  controller: AgentController
}) {
  const toggle = () => void (sharing ? controller.stopShare() : controller.startShare())
  return (
    <section className="agent-room">
      <h2>{text.room.joined(roomName)}</h2>
      <p className="agent-muted">{text.room.owner(ownerName)}</p>
      <p className="agent-status" role="status">
        {view.reconnecting ? text.room.reconnecting : ''}
      </p>
      <ControlLine />
      <div className={sharing ? 'agent-share agent-share-on' : 'agent-share'}>
        <button
          type="button"
          role="switch"
          aria-checked={sharing}
          aria-describedby="share-state"
          disabled={view.shareBusy || view.reconnecting}
          onClick={toggle}
          className="agent-switch"
        >
          <span className="agent-switch-track" aria-hidden="true">
            <span className="agent-switch-thumb" />
          </span>
          <span>{text.room.share}</span>
        </button>
        <p id="share-state" className="agent-muted">
          {sharing ? text.room.sharing : text.room.notSharing}
        </p>
        <small className="agent-muted">{text.room.pickHint}</small>
        {sharing && (
          <button
            type="button"
            disabled={view.shareBusy || view.reconnecting}
            onClick={() => void controller.switchScreen()}
          >
            {text.room.switchScreen}
          </button>
        )}
      </div>
      {sharing && view.screens.length > 1 && <ScreenPicker view={view} controller={controller} />}
      <p className="agent-problem" role="alert">
        {view.notice ? text.shareProblems[view.notice] : ''}
      </p>
      <button type="button" className="agent-danger" onClick={() => void controller.leave()}>
        {text.room.leave}
      </button>
    </section>
  )
}

/**
 * 「你分享的是哪一個螢幕？」 (N5, e9-t09): when several screens fit the share (two identical
 * monitors), which one the controller's pointer aims at. Not while someone controls this computer
 * (Rust refuses it too: a click of theirs must not move the pointer to a screen nobody sees).
 */
function ScreenPicker({ view, controller }: { view: AgentView; controller: AgentController }) {
  const control = useControlView().view
  const aimed = view.screens.find((screen) => screen.aimed)?.index
  return (
    <label className="agent-screens">
      <span>{text.room.whichScreen}</span>
      <select
        value={aimed ?? ''}
        disabled={control.phase === 'granted'}
        onChange={(event) => void controller.chooseScreen(Number(event.target.value))}
      >
        {view.screens.map((screen) => (
          <option key={screen.index} value={screen.index}>
            {text.room.screenLabel(screen.index + 1, screen.width, screen.height, screen.primary)}
          </option>
        ))}
      </select>
      <small className="agent-muted">{text.room.whichScreenHint}</small>
    </label>
  )
}
