import { useEffect } from 'react'
import type { ControllerServerMessage, ControlErrorCode } from '../../shared/control.ts'
import type { ClientMessage, ErrorCode, Member, RoomView } from '../../shared/protocol.ts'
import { can, type Role } from '../../shared/roles.ts'
import type { ShareControl } from '../components/ShareTile.tsx'
import type { ToastTone } from '../components/useToasts.ts'
import { strings } from '../strings.ts'
import type { MyControl } from './RoomConnection.ts'

const CONTROL_ERRORS: readonly ControlErrorCode[] = [
  'control_busy',
  'control_not_agent',
  'control_separated',
  'control_cooldown',
  'control_muted',
  'control_off',
]

const isControlError = (code: ErrorCode): code is ControlErrorCode =>
  CONTROL_ERRORS.includes(code as ControlErrorCode)

export interface RemoteControlOptions {
  view: RoomView | null
  you: string | null
  role: Role
  /** Our own request or grant (RoomConnection's `control`) */
  mine: MyControl | null
  send: (message: ClientMessage) => void
  onControl: (listener: (message: ControllerServerMessage) => void) => () => void
  onError: (listener: (code: ErrorCode) => void) => () => void
  show: (text: string, tone?: ToastTone) => void
}

/**
 * Remote control in the room page (N3, e9-t04, e9-t05): what each computer's share tile shows and
 * offers (ShareControl), and what we are told about our own requests. RoomDO decides everything
 * (CLAUDE.md rule 1): the buttons only follow `RoomView.control`, our role and the room's switch.
 * Everyone's notices (`controlStarted`, `controlEnded`) are the room page's, with the others.
 */
export function useRemoteControl({
  view,
  you,
  role,
  mine,
  send,
  onControl,
  onError,
  show,
}: RemoteControlOptions) {
  const nameOf = (id: string) => view?.members[id]?.name ?? ''

  useEffect(
    () =>
      onControl((message) => {
        // A cancel is our own doing: nothing to say
        if (message.t === 'controlRefused' && message.reason !== 'cancelled') {
          show(strings.control.refused[message.reason], 'warn')
        }
      }),
    [onControl, show],
  )
  useEffect(
    () =>
      onError((code) => {
        if (isControlError(code)) show(strings.control.errors[code], 'warn')
      }),
    [onError, show],
  )

  const allowed = view?.room.allowControl !== false && can(role, 'requestControl')

  /** What the share tile of `sharer` gets; null for a person's share */
  const shareControl = (sharer: Member): ShareControl | null => {
    if (!sharer.agent) return null
    const session = view?.control?.[sharer.id] ?? null
    const ours = mine !== null && mine.agent === sharer.id ? mine : null
    const granted = session?.phase === 'granted'
    const status = session
      ? {
          text: granted
            ? session.controller === you
              ? strings.control.youControl
              : strings.control.controlling(nameOf(session.controller))
            : session.controller === you
              ? strings.control.waitingAnswer
              : strings.control.asking(nameOf(session.controller)),
          granted,
          until: granted ? session.until : null,
        }
      : null
    let action: ShareControl['action'] = null
    if (ours?.grant) {
      const grant = ours.grant
      action = {
        label: strings.control.stop,
        title: strings.control.captureHint,
        danger: true,
        onClick: () => send({ t: 'controlStop', grant }),
      }
    } else if (ours?.request) {
      const request = ours.request
      action = {
        label: strings.control.cancel,
        title: strings.control.cancel,
        onClick: () => send({ t: 'controlCancel', request }),
      }
    } else if (session === null && allowed && mine === null) {
      action = {
        label: strings.control.request,
        title: strings.control.requestHint,
        onClick: () => send({ t: 'controlRequest', agent: sharer.id }),
      }
    }
    const capture =
      ours?.grant && granted && session?.controller === you
        ? {
            grant: ours.grant,
            send: (message: ClientMessage) => send(message),
            label: strings.control.captureLabel(sharer.name),
          }
        : null
    return { status, action, capture }
  }

  /** The agents someone controls now (the participants list's 停止遠端控制) */
  const controlledIds = Object.values(view?.control ?? {})
    .filter((session) => session.phase === 'granted')
    .map((session) => session.agent)

  return { shareControl, controlledIds }
}
