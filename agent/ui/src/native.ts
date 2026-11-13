// The agent's Rust side (src-tauri/src/lib.rs), the only IPC the page has: the commands listed in
// build.rs and granted in capabilities/main.json, and two events. The room socket and every HTTP
// call live in Rust (one domain, the token never in the page, nothing published before the local
// confirmation: session.rs).
import { Channel, invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/** session.rs Phase, as serde writes it */
export type Phase =
  | { phase: 'idle' }
  | { phase: 'connecting' }
  | ({ phase: 'confirming' } & RoomLabel)
  | ({ phase: 'inRoom'; sharing: boolean } & RoomLabel)

/** Who issued the pairing code, and the room's name (null: unnamed, shown from `createdBy`) */
export interface RoomLabel {
  ownerName: string
  roomName: string | null
  createdBy: string | null
}

/** socket.rs SocketEvent */
export type SocketEvent =
  | { kind: 'open' }
  | { kind: 'message'; data: string }
  | { kind: 'close'; code: number; reason: string }

export interface AgentInfo {
  device: string
  platform: 'windows' | 'macos' | 'linux'
  build: string
  /** The one origin this build talks to */
  origin: string
}

/** control.rs ControlView (N3), as serde writes it; times are ms as of when it was sent */
export type ControlView =
  | { phase: 'idle' }
  | {
      phase: 'asking'
      request: string
      fromName: string
      roomName: string | null
      createdBy: string | null
      leftMs: number
      armMs: number
    }
  | {
      phase: 'granted'
      controllerName: string
      untilStopped: boolean
      leftMs: number | null
      /** The hourly question is up: [ms left to answer, ms until its buttons work] */
      reconfirm: [number, number] | null
    }

/** What the tray asks the window to do (tray.rs TRAY_EVENT) */
export type TrayAction = 'share' | 'unshare' | 'leave'

export const native = {
  info: () => invoke<AgentInfo>('agent_info'),
  sessionState: () => invoke<Phase>('session_state'),
  /** With `pairing`: a new session in `room`; without: reconnect the session there is */
  connect(
    args: { room: string | null; pairing: string | null; device: string },
    onEvent: (event: SocketEvent) => void,
  ): Promise<void> {
    const channel = new Channel<SocketEvent>()
    channel.onmessage = onEvent
    return invoke<void>('socket_connect', { ...args, onEvent: channel })
  },
  send: (text: string) => invoke<void>('socket_send', { text }),
  confirm: (accept: boolean) => invoke<void>('confirm_join', { accept }),
  setSharing: (on: boolean) => invoke<void>('set_sharing', { on }),
  leave: () => invoke<void>('leave_room'),
  apiFetch: (method: string, path: string, body: string | null) =>
    invoke<{ status: number; body: string }>('api_fetch', { method, path, body }),
  // Remote control (N3): each window may call only what its capability grants (the consent window
  // alone answers, capabilities/consent.json)
  controlState: () => invoke<ControlView>('control_state'),
  controlAnswer: (request: string, decision: string, muteMs: number | null) =>
    invoke<void>('control_answer', { request, decision, muteMs }),
  controlKeepGoing: () => invoke<void>('control_keep_going'),
  controlStop: () => invoke<void>('control_stop'),
  onControl: (handler: (view: ControlView) => void): Promise<UnlistenFn> =>
    listen<ControlView>('agent://control', (event) => handler(event.payload)),
  onSession: (handler: (phase: Phase) => void): Promise<UnlistenFn> =>
    listen<Phase>('agent://session', (event) => handler(event.payload)),
  onTray: (handler: (action: TrayAction) => void): Promise<UnlistenFn> =>
    listen<TrayAction>('agent://tray', (event) => handler(event.payload)),
}

const NULL_BODY_STATUSES = [101, 204, 205, 304]

/**
 * `fetch` for CloudflareRealtimeTransport and TURN: the path goes to Rust (api_fetch), which checks
 * it, adds the agent token and calls the one origin. A refusal or a network failure rejects, as
 * fetch does on a network error.
 */
export const nativeFetch: typeof fetch = async (input, init) => {
  const path =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.pathname
        : new URL(input.url).pathname
  const method = (init?.method ?? 'GET').toUpperCase()
  const body = typeof init?.body === 'string' ? init.body : null
  let res: { status: number; body: string }
  try {
    res = await native.apiFetch(method, path, body)
  } catch (error) {
    throw new TypeError(`agent fetch refused: ${String(error)}`)
  }
  return new Response(NULL_BODY_STATUSES.includes(res.status) ? null : res.body, {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  })
}
