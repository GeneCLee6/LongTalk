// The agent's window: the join form, connecting, the local confirmation (§5.1 step 4), the room
// with the 「分享我的螢幕」 switch. What phase it is in is Rust's (session.rs); text is i18n.ts's.
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { CONSENT_DIALOG_ARM_MS } from '../../../shared/control.ts'
import { ControlLine } from './control.tsx'
import type { AgentController, AgentView } from './controller.ts'
import { defaultDevice } from './deviceName.ts'
import { text } from './i18n.ts'

export function App({ controller }: { controller: AgentController }) {
  const view = useSyncExternalStore(controller.subscribe, controller.getView)
  return (
    <main className="agent">
      <header className="agent-header">
        <img className="agent-logo" src="/logo.svg" alt="" width={28} height={28} />
        <h1>{text.appName}</h1>
      </header>
      <Screen view={view} controller={controller} />
    </main>
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
      </div>
      <p className="agent-problem" role="alert">
        {view.notice ? text.shareProblems[view.notice] : ''}
      </p>
      <button type="button" className="agent-danger" onClick={() => void controller.leave()}>
        {text.room.leave}
      </button>
    </section>
  )
}
