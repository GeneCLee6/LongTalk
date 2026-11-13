import { useEffect, useId, useState, type KeyboardEvent } from 'react'
import styled from 'styled-components'
import { formatPairingCode } from '../../shared/control.ts'
import type { PairCodeState } from '../room/RoomConnection.ts'
import { strings } from '../strings.ts'
import { color, font, fontSize, layer, radius, space } from '../styles/tokens.ts'
import { Button } from './Button.tsx'
import { AlertIcon } from './icons.tsx'

/** Where the LongTalk agent is downloaded (N2, e9-t02): the releases until N5 has a page of its own */
export const AGENT_DOWNLOAD_URL = 'https://github.com/GeneCLee6/LongTalk/releases'

/** What the masked code looks like: the same shape as the code, nothing of it */
const MASK = '••••-••••'

export interface PairComputerDialogProps {
  /** The latest `pairCode` the room sent us (RoomConnectionState.pairCode) */
  pairCode: PairCodeState | null
  /** Our own computer, when it is in the room already: one per member */
  myComputer: { id: string; device: string } | null
  /** The room said `pair_busy` to our last `pairStart` */
  busy: boolean
  /** A computer joined with our code (`agentPaired`) since the dialog opened */
  paired: { id: string; device: string } | null
  /** We share our screen (or are about to): the code is easiest to leak there (A5) */
  sharing: boolean
  /** `pairStart` */
  onGenerate: () => void
  /** `pairCancel` */
  onCancelCode: () => void
  /** `agentRemove`: 中斷我的電腦, 這不是我 */
  onRemove: (memberId: string) => void
  /** The copy button's outcome, for a toast */
  onCopied: (ok: boolean) => void
  onClose: () => void
  /** The clock, for tests */
  now?: () => number
}

type Phase = 'intro' | 'waiting' | 'code' | 'ended' | 'busy' | 'paired'

/** 4:59 */
function formatLeft(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * 更多 › 連接我的電腦 (N2, e9-t02; docs/PRD/f-remote-control-security.md §5.1): what the LongTalk
 * agent is and where to get it, then a one-time pairing code from the room. The code is hidden
 * until 顯示 (§5.1 item 9), with a warning while we share our screen; it counts down to
 * PAIRING_CODE_TTL_MS, and can be copied, made again (重新產生) or voided (取消). When the room
 * says `pair_busy`, or our computer is already in the room, it offers 中斷我的電腦 instead; when
 * the code is used it says so, and names the computer once it joins (with 這不是我). Closing it
 * keeps the code: the agent may be typed in on another computer while this one shows it. Lazy
 * (RoomPage): nobody needs it to be in a meeting.
 */
export default function PairComputerDialog({
  pairCode,
  myComputer,
  busy,
  paired,
  sharing,
  onGenerate,
  onCancelCode,
  onRemove,
  onCopied,
  onClose,
  now = Date.now,
}: PairComputerDialogProps) {
  const text = strings.agent
  const titleId = useId()
  const bodyId = useId()
  const [clock, setClock] = useState(now)
  const live = (state: PairCodeState | null) =>
    state !== null && state.code !== null && state.deadline !== null && state.deadline > now()
  // The `pairCode` we wait past: asked for now, or the one still open when the dialog opened
  const [asked, setAsked] = useState<number | null>(() =>
    pairCode && live(pairCode) ? pairCode.seq - 1 : null,
  )
  const [revealed, setRevealed] = useState(false)
  const answered = asked !== null && pairCode !== null && pairCode.seq > asked
  const left =
    answered && pairCode.code !== null && pairCode.deadline !== null ? pairCode.deadline - clock : 0
  const phase: Phase = paired
    ? 'paired'
    : myComputer || busy
      ? 'busy'
      : asked === null
        ? 'intro'
        : !answered
          ? 'waiting'
          : left > 0
            ? 'code'
            : 'ended'

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    return () => before?.focus?.()
  }, [])
  // The countdown, while there is a code to count down
  useEffect(() => {
    if (phase !== 'code') return
    const timer = setInterval(() => setClock(now()), 1000)
    return () => clearInterval(timer)
  }, [phase, now])

  const generate = () => {
    setAsked(pairCode?.seq ?? 0)
    setRevealed(false)
    setClock(now())
    onGenerate()
  }
  const cancel = () => {
    onCancelCode()
    setAsked(null)
    setRevealed(false)
  }
  const remove = (memberId: string) => {
    onRemove(memberId)
    setAsked(null)
  }
  const copy = (code: string) => {
    const clipboard = navigator.clipboard
    if (!clipboard?.writeText) {
      onCopied(false)
      return
    }
    clipboard.writeText(formatPairingCode(code)).then(
      () => onCopied(true),
      () => onCopied(false),
    )
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
    }
  }

  return (
    <Backdrop onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <Panel
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId}>{phase === 'paired' ? text.pairedTitle(paired!.device) : text.title}</h2>
        {sharing && phase !== 'paired' && (
          <Warning role="note">
            <AlertIcon />
            <span>{text.sharingWarning}</span>
          </Warning>
        )}
        {phase === 'paired' ? (
          <>
            <p id={bodyId}>{text.pairedBody}</p>
            <Actions>
              <Button type="button" variant="secondary" onClick={() => remove(paired!.id)}>
                {text.notMe}
              </Button>
              <Button type="button" autoFocus onClick={onClose}>
                {text.done}
              </Button>
            </Actions>
          </>
        ) : phase === 'busy' ? (
          <>
            <p id={bodyId}>{myComputer ? text.busyNamed(myComputer.device) : text.busy}</p>
            <Actions>
              <Button type="button" variant="secondary" onClick={onClose}>
                {strings.common.close}
              </Button>
              {myComputer && (
                <Button type="button" variant="danger" onClick={() => remove(myComputer.id)}>
                  {text.disconnectMine}
                </Button>
              )}
            </Actions>
          </>
        ) : (
          <>
            <Intro id={bodyId}>
              <p>{text.intro}</p>
              <p>{text.introSafety}</p>
              <p>
                <a href={AGENT_DOWNLOAD_URL} target="_blank" rel="noreferrer">
                  {text.download}
                </a>
              </p>
            </Intro>
            {phase === 'code' && pairCode?.code && (
              <CodeBox aria-label={text.codeLabel} role="group">
                <CodeRow>
                  <Code data-pairing-code="" $hidden={!revealed}>
                    {revealed ? (
                      formatPairingCode(pairCode.code)
                    ) : (
                      <>
                        <span aria-hidden="true">{MASK}</span>
                        <VisuallyHidden>{text.codeHidden}</VisuallyHidden>
                      </>
                    )}
                  </Code>
                  <Button
                    type="button"
                    variant="secondary"
                    aria-pressed={revealed}
                    onClick={() => setRevealed((shown) => !shown)}
                  >
                    {revealed ? text.hide : text.show}
                  </Button>
                  <Button type="button" variant="secondary" onClick={() => copy(pairCode.code!)}>
                    {text.copy}
                  </Button>
                </CodeRow>
                <Left role="timer" aria-live="off">
                  {text.expiresIn(formatLeft(left))}
                </Left>
              </CodeBox>
            )}
            {phase === 'ended' && <Ended role="status">{text.ended}</Ended>}
            <Actions>
              {phase === 'code' ? (
                <>
                  <Button type="button" variant="secondary" onClick={cancel}>
                    {text.cancelCode}
                  </Button>
                  <Button type="button" variant="secondary" onClick={generate}>
                    {text.regenerate}
                  </Button>
                  <Button type="button" autoFocus onClick={onClose}>
                    {strings.common.close}
                  </Button>
                </>
              ) : (
                <>
                  <Button type="button" variant="secondary" onClick={onClose}>
                    {strings.common.close}
                  </Button>
                  <Button type="button" autoFocus disabled={phase === 'waiting'} onClick={generate}>
                    {phase === 'waiting'
                      ? text.generating
                      : phase === 'ended'
                        ? text.regenerate
                        : text.generate}
                  </Button>
                </>
              )}
            </Actions>
          </>
        )}
      </Panel>
    </Backdrop>
  )
}

const Backdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: ${layer.menu};
  display: grid;
  place-items: center;
  padding: ${space(4)};
  background: ${color.overlay};
`

const Panel = styled.div`
  display: grid;
  gap: ${space(3)};
  width: min(100%, 460px);
  max-height: 100%;
  overflow: auto;
  padding: ${space(5)};
  border: 1px solid ${color.line};
  border-radius: ${radius.panel};
  background: ${color.surface};
  color: ${color.fg};
  box-shadow: 0 8px 24px ${color.shadow};

  h2 {
    margin: 0;
    font-size: 18px;
    overflow-wrap: anywhere;
  }
  p {
    margin: 0;
    color: ${color.muted};
    font-size: ${fontSize.small};
    line-height: 1.6;
  }
  a {
    color: ${color.primary};
    font-weight: 600;
  }
  a:focus-visible {
    outline: 2px solid ${color.focus};
    outline-offset: 2px;
  }
`

const Intro = styled.div`
  display: grid;
  gap: ${space(2)};
`

/** 你正在分享畫面: the dialog itself may be on everyone's screen */
const Warning = styled.p`
  && {
    display: flex;
    align-items: flex-start;
    gap: ${space(2)};
    padding: ${space(2)} ${space(3)};
    border-left: 4px solid ${color.warn};
    border-radius: ${radius.button};
    background: ${color.surface2};
    color: ${color.fg};
  }

  svg {
    flex: none;
    width: 18px;
    height: 18px;
    margin-top: 2px;
    color: ${color.warn};
  }
`

const CodeBox = styled.div`
  display: grid;
  gap: ${space(1)};
  padding: ${space(3)};
  border: 1px solid ${color.line};
  border-radius: ${radius.button};
  background: ${color.surface2};
`

const CodeRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: ${space(2)};
`

const Code = styled.span<{ $hidden: boolean }>`
  flex: 1;
  min-width: 10ch;
  font-family: ${({ $hidden }) => ($hidden ? font.secret : font.mono)};
  font-size: 24px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: ${({ $hidden }) => ($hidden ? color.muted : color.fg)};
`

const VisuallyHidden = styled.span`
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
`

const Left = styled.span`
  color: ${color.muted};
  font-size: ${fontSize.nameplate};
`

const Ended = styled.p`
  && {
    color: ${color.fg};
  }
`

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: ${space(2)};
`
