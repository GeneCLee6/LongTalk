// Remote control's windows on the controlled computer (N3, e9-t04; f-remote-control-security.md
// §5.2 step 3, §5.4), each its own native window that Rust opens and closes
// (src-tauri/src/control_windows.rs) on the same bundled page with a hash:
// - `#consent`: 「Bob 想控制這台電腦」 with 允許 10 分鐘／允許直到我中斷／拒絕 (拒絕 focused, Enter is
//   拒絕), 「不再接受請求 N 分鐘」 next to 拒絕, the 60-second countdown; or, during an until-stopped
//   grant, the hourly 「還要繼續讓 Bob 控制嗎？」. N5: 「也允許對方把文字貼到這台電腦的剪貼簿」, not
//   ticked unless the person ticks it (§5.11). Nothing works for CONSENT_DIALOG_ARM_MS (Rust
//   refuses it too), and only this window may answer (capabilities/consent.json);
// - `#stop`: the floating 中斷 button and who controls, with the time left; for a few seconds
//   after the controller pressed a combination that opens something powerful, which one (N4), or
//   pasted text (N5); while pasting is allowed, 「不允許貼上」 (only ever off);
// - `#border`: one red strip of the border around every screen.
// The state is Rust's (control.rs ControlView), read on open and followed through `agent://control`.
import { useEffect, useRef, useState } from 'react'
import { CONTROL_MUTE_OPTIONS_MS } from '../../../shared/control.ts'
import { text } from './i18n.ts'
import { native, type ControlView } from './native.ts'

/** Rust's control view, as of when it last changed, with when that was on our clock */
export function useControlView(): { view: ControlView; at: number } {
  const [state, setState] = useState<{ view: ControlView; at: number }>({
    view: { phase: 'idle' },
    at: Date.now(),
  })
  useEffect(() => {
    let live = true
    const set = (view: ControlView) => {
      if (live) setState({ view, at: Date.now() })
    }
    const off = native.onControl(set)
    void native.controlState().then(set, () => {})
    return () => {
      live = false
      void off.then((unlisten) => unlisten())
    }
  }, [])
  return state
}

/** Ticks every half second while mounted: countdowns */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [])
  return now
}

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function ConsentWindow() {
  const { view, at } = useControlView()
  const now = useNow()
  const deny = useRef<HTMLButtonElement>(null)
  const [mute, setMute] = useState(false)
  const [paste, setPaste] = useState(false)
  const [muteMs, setMuteMs] = useState(CONTROL_MUTE_OPTIONS_MS[1])
  const [problem, setProblem] = useState<string | null>(null)
  // The view's times are as of `at`; the tick may come from just before it
  const since = Math.max(0, now - at)
  const armMs =
    view.phase === 'asking'
      ? view.armMs
      : view.phase === 'granted' && view.reconfirm
        ? view.reconfirm[1]
        : 0
  const armed = since >= armMs
  // 拒絕 has the focus once the buttons work, so Enter is 拒絕 (useNow re-renders within 0.5 s)
  useEffect(() => {
    if (armed) deny.current?.focus()
  }, [armed])

  const fail = (error: unknown) => {
    const code = String(error)
    setProblem(code === 'notArmed' ? null : text.control.failed)
  }

  if (view.phase === 'asking') {
    const left = view.leftMs - since
    const answer = (decision: 'allow10' | 'allowUntilStop' | 'deny') =>
      void native
        .controlAnswer(
          view.request,
          decision,
          decision === 'deny' && mute ? muteMs : null,
          decision !== 'deny' && paste,
        )
        .catch(fail)
    const room = text.roomName(view.roomName, view.createdBy)
    return (
      <main className="agent agent-consent" aria-labelledby="consent-title">
        <h1 id="consent-title">{text.control.asks(view.fromName)}</h1>
        <p className="agent-muted">{text.control.inRoom(room)}</p>
        <p className="agent-muted">{text.control.nameNote}</p>
        <p className="agent-question">{text.control.consequence}</p>
        <p className="agent-status" role="timer">
          {text.control.closesIn(clock(left))}
        </p>
        <div className="agent-consent-actions">
          <button
            type="button"
            className="agent-primary"
            disabled={!armed}
            onClick={() => answer('allow10')}
          >
            {text.control.allow10}
          </button>
          <button type="button" disabled={!armed} onClick={() => answer('allowUntilStop')}>
            {text.control.allowUntilStop}
          </button>
          <button
            ref={deny}
            type="button"
            className="agent-danger"
            disabled={!armed}
            onClick={() => answer('deny')}
          >
            {text.control.deny}
          </button>
        </div>
        <label className="agent-check">
          <input type="checkbox" checked={paste} onChange={(e) => setPaste(e.target.checked)} />
          <span>{text.control.allowPaste}</span>
        </label>
        <p className="agent-muted agent-check-note">{text.control.allowPasteNote}</p>
        <label className="agent-check">
          <input type="checkbox" checked={mute} onChange={(e) => setMute(e.target.checked)} />
          <span>{text.control.mute}</span>
          <select
            value={muteMs}
            disabled={!mute}
            aria-label={text.control.muteFor}
            onChange={(e) => setMuteMs(Number(e.target.value))}
          >
            {CONTROL_MUTE_OPTIONS_MS.filter((ms) => ms > 0).map((ms) => (
              <option key={ms} value={ms}>
                {text.control.minutes(ms / 60_000)}
              </option>
            ))}
          </select>
        </label>
        <p className="agent-problem" role="alert">
          {problem ?? ''}
        </p>
      </main>
    )
  }
  if (view.phase === 'granted' && view.reconfirm) {
    const left = view.reconfirm[0] - since
    return (
      <main className="agent agent-consent" aria-labelledby="consent-title">
        <h1 id="consent-title">{text.control.reconfirm(view.controllerName)}</h1>
        <p className="agent-muted">{text.control.reconfirmNote}</p>
        <p className="agent-status" role="timer">
          {text.control.closesIn(clock(left))}
        </p>
        <div className="agent-consent-actions">
          <button
            type="button"
            disabled={!armed}
            onClick={() => void native.controlKeepGoing().catch(fail)}
          >
            {text.control.keepGoing}
          </button>
          <button
            ref={deny}
            type="button"
            className="agent-danger"
            disabled={!armed}
            onClick={() => void native.controlStop()}
          >
            {text.control.stop}
          </button>
        </div>
        <p className="agent-problem" role="alert">
          {problem ?? ''}
        </p>
      </main>
    )
  }
  return null
}

export function StopWindow() {
  const { view, at } = useControlView()
  const now = useNow()
  if (view.phase !== 'granted') return null
  const left = view.leftMs === null ? null : view.leftMs - Math.max(0, now - at)
  return (
    <main className="agent-stop" data-tauri-drag-region="">
      {view.hint ? (
        <span className="agent-stop-who agent-stop-hint" role="status" data-tauri-drag-region="">
          {text.control.pressed(view.controllerName, view.hint)}
        </span>
      ) : view.pasted !== null ? (
        <span className="agent-stop-who agent-stop-hint" role="status" data-tauri-drag-region="">
          {text.control.pasted(view.controllerName, view.pasted)}
        </span>
      ) : (
        <span className="agent-stop-who" data-tauri-drag-region="">
          {text.control.controlling(view.controllerName)}
          {left !== null && ` · ${clock(left)}`}
        </span>
      )}
      {view.clipboard && (
        <button
          type="button"
          className="agent-stop-paste"
          title={text.control.pasteOn}
          onClick={() => void native.controlClipboardOff()}
        >
          {text.control.pasteOff}
        </button>
      )}
      <button type="button" className="agent-stop-button" onClick={() => void native.controlStop()}>
        {text.control.stop}
      </button>
    </main>
  )
}

export function BorderWindow() {
  return <div className="agent-border" aria-hidden="true" />
}

/** In the main window, while someone controls this computer: who, and 中斷 */
export function ControlLine() {
  const { view } = useControlView()
  if (view.phase !== 'granted') return null
  return (
    <div className="agent-control-line" role="status">
      <span>{text.control.controlling(view.controllerName)}</span>
      {view.clipboard && (
        <button type="button" onClick={() => void native.controlClipboardOff()}>
          {text.control.pasteOff}
        </button>
      )}
      <button type="button" className="agent-danger" onClick={() => void native.controlStop()}>
        {text.control.stop}
      </button>
    </div>
  )
}
