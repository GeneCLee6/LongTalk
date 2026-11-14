// The agent's flow in the page (e9-t02, e9-t03): join with a room and a pairing code, the local
// confirmation, the room, the screen share, reconnecting and leaving. The session itself (what
// phase, whether anything may be published) is Rust's (src-tauri/src/session.rs); this follows it
// through `agent://session` and drives what only a page can do:
// - the room socket's heartbeat (`ping` every HEARTBEAT_INTERVAL_MS) and reconnecting with backoff
//   when it drops (Rust reconnects with the token it keeps; a 44xx close ends the session);
// - the screen: getDisplayMedia (the WebView's picker: the person chooses which monitor), then
//   `share`, publish through the same MediaTransport as the web app (CLAUDE.md rule 2), `tracks`;
//   stopping is `tracks` without it and `unshare`. Rust refuses all of it unless the person
//   confirmed and turned the switch on (T-01a), so a bug here cannot publish early.
// - N5 (e9-t08, e9-t09): another screen while sharing (the picker again, the new track replacing
//   the old under the same track name: the room sees the same share); which of several same-sized
//   screens the controller's pointer aims at (Rust decides, and refuses a change while controlled);
//   what the OS must allow (permissions.rs), read again whenever the window comes back to the front.
import { normalizeLabel, normalizePairingCode } from '../../../shared/control.ts'
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  RECONNECT_GRACE_MS,
} from '../../../shared/protocol.ts'
import { sfuApiBase } from '../../../shared/sfu.ts'
import { STUN_SERVER, turnPath, usableIceServers } from '../../../shared/turn.ts'
import { CloudflareRealtimeTransport } from '../../../src/media/CloudflareRealtimeTransport.ts'
import type { MediaTransport, PublishedTrack } from '../../../src/media/MediaTransport.ts'
import { captureScreen, type ShareProblem } from '../../../src/media/share.ts'
import { Backoff } from '../../../src/room/backoff.ts'
import { closeProblem, parseJoinTarget, type CloseProblem } from './link.ts'
import {
  native,
  nativeFetch,
  type AgentInfo,
  type Permissions,
  type Phase,
  type ScreenChoice,
  type SocketEvent,
} from './native.ts'

export type JoinProblem =
  'foreignLink' | 'badRoom' | 'badPairing' | 'badDevice' | CloseProblem | 'lost'
export type ShareNotice = Exclude<ShareProblem, 'cancelled'> | 'full' | 'audioOnly' | 'fromTray'

export interface AgentView {
  info: AgentInfo | null
  phase: Phase
  /** The socket dropped and is being opened again (the session goes on) */
  reconnecting: boolean
  /** Why the last join or session ended, for the join form */
  problem: JoinProblem | null
  /** About the screen share, in the room */
  notice: ShareNotice | null
  /** The picker is open or the share is being set up or taken down */
  shareBusy: boolean
  /** N5: what the OS must allow (null until read) */
  permissions: Permissions | null
  /** N5: the screens that fit the share, when several do (else empty) */
  screens: ScreenChoice[]
}

export class AgentController {
  #view: AgentView = {
    info: null,
    phase: { phase: 'idle' },
    reconnecting: false,
    problem: null,
    notice: null,
    shareBusy: false,
    permissions: null,
    screens: [],
  }
  #listeners = new Set<() => void>()
  #device = ''
  #welcomed = false
  #heartbeat: ReturnType<typeof setInterval> | null = null
  #retry: ReturnType<typeof setTimeout> | null = null
  #backoff = new Backoff({ giveUpAfterMs: RECONNECT_GRACE_MS })
  #room: string | null = null
  #transport: MediaTransport | null = null
  #screen: MediaStreamTrack | null = null
  #published: PublishedTrack | null = null

  get view(): AgentView {
    return this.#view
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  getView = (): AgentView => this.#view

  #set(patch: Partial<AgentView>): void {
    this.#view = { ...this.#view, ...patch }
    for (const listener of this.#listeners) listener()
  }

  async start(): Promise<void> {
    await native.onSession((phase) => this.#onPhase(phase))
    await native.onTray((action) => {
      if (action === 'share') void this.startShare(true)
      else if (action === 'unshare') void this.stopShare()
      else void this.leave()
    })
    const [info, phase] = await Promise.all([native.info(), native.sessionState()])
    this.#set({ info })
    this.#onPhase(phase)
    await this.refreshPermissions()
  }

  /** N5: reads what the OS allows now (on start, and when the window comes back to the front) */
  async refreshPermissions(): Promise<void> {
    const permissions = await native.permissions().catch(() => null)
    if (permissions) this.#set({ permissions })
  }

  /** N5: the guide's 「打開設定」 (macOS asks, its settings page opens) */
  async requestPermission(kind: 'screen' | 'accessibility' | 'inputMonitoring'): Promise<void> {
    await native.requestPermission(kind).catch(() => false)
  }

  /** N5: 「你分享的是哪一個螢幕？」 (Rust refuses it while someone controls this computer) */
  async chooseScreen(index: number | null): Promise<void> {
    await native.chooseScreen(index).catch(() => {})
    await this.#refreshScreens()
  }

  async #refreshScreens(): Promise<void> {
    const screens = await native.screens().catch((): ScreenChoice[] => [])
    this.#set({ screens })
  }

  /** Tells Rust which screen the track shows, for remote control's pointer (N4) */
  async #aim(track: MediaStreamTrack | null): Promise<void> {
    const settings = track?.getSettings()
    await native
      .sharedScreen(
        settings?.width ?? null,
        settings?.height ?? null,
        settings !== undefined &&
          (settings.displaySurface === undefined || settings.displaySurface === 'monitor'),
      )
      .catch(() => {})
    await this.#refreshScreens()
  }

  #onPhase(phase: Phase): void {
    if (phase.phase === 'confirming' || phase.phase === 'inRoom') this.#welcomed = true
    this.#set({ phase })
    if (phase.phase === 'idle') this.#teardown()
  }

  /** 加入 on the form: checks what was typed, then opens the socket with the code */
  async join(link: string, pairing: string, device: string): Promise<void> {
    const origin = this.#view.info?.origin
    if (!origin) return
    const target = parseJoinTarget(link, origin)
    if (!target.ok) return this.#set({ problem: target.problem })
    const code = normalizePairingCode(pairing)
    if (code === null) return this.#set({ problem: 'badPairing' })
    const name = normalizeLabel(device)
    if (name === null) return this.#set({ problem: 'badDevice' })
    this.#device = name
    this.#room = target.room
    this.#welcomed = false
    this.#backoff.reset()
    this.#set({ problem: null, notice: null, reconnecting: false })
    try {
      await native.connect({ room: target.room, pairing: code, device: name }, this.#onSocket)
    } catch {
      this.#set({ problem: 'failed' })
    }
  }

  #onSocket = (event: SocketEvent): void => {
    switch (event.kind) {
      case 'open':
        this.#startHeartbeat()
        return
      case 'message':
        this.#onMessage(event.data)
        return
      case 'close':
        this.#stopHeartbeat()
        void this.#onClose(event.code)
    }
  }

  #onMessage(data: string): void {
    if (data === HEARTBEAT_PONG) return
    let message: { t?: unknown; code?: unknown }
    try {
      message = JSON.parse(data) as typeof message
    } catch {
      return
    }
    if (message.t === 'agentWelcome') {
      const again = this.#view.reconnecting
      this.#backoff.reset()
      this.#set({ reconnecting: false })
      // Back after a drop while sharing: the room keeps the share for RECONNECT_GRACE_MS; say
      // again what we publish, like the web app after every `welcome`
      if (again && this.#published) void this.#announceShare(true).catch(() => {})
      return
    }
    if (message.t === 'error' && (message.code === 'share_full' || message.code === 'audio_only')) {
      void this.stopShare(message.code === 'share_full' ? 'full' : 'audioOnly')
    }
  }

  async #onClose(code: number): Promise<void> {
    // Rust has already decided whether the session goes on (session.rs on_socket_closed)
    const phase = await native.sessionState().catch((): Phase => ({ phase: 'idle' }))
    this.#onPhase(phase)
    if (phase.phase === 'idle') {
      if (code !== 1000)
        this.#set({ problem: closeProblem(code, this.#welcomed), reconnecting: false })
      return
    }
    const delay = this.#backoff.next()
    if (delay === null) {
      this.#set({ problem: 'lost' })
      await this.leave()
      return
    }
    this.#set({ reconnecting: true })
    this.#retry = setTimeout(() => {
      this.#retry = null
      native
        .connect({ room: null, pairing: null, device: this.#device }, this.#onSocket)
        .catch(() => void this.#onClose(1006))
    }, delay)
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat()
    this.#heartbeat = setInterval(() => {
      native.send(HEARTBEAT_PING).catch(() => {})
    }, HEARTBEAT_INTERVAL_MS)
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat)
    this.#heartbeat = null
  }

  /** The local confirmation's 加入 or 取消 (Rust ignores both for CONSENT_DIALOG_ARM_MS) */
  async confirm(accept: boolean): Promise<void> {
    await native.confirm(accept).catch(() => {})
  }

  /**
   * 「分享我的螢幕」 on. Called in the click (the picker wants a user gesture); from the tray there
   * is none, so a refused picker there asks the person to use the window.
   */
  async startShare(fromTray = false): Promise<void> {
    if (this.#view.phase.phase !== 'inRoom' || this.#screen || this.#view.shareBusy) return
    this.#set({ shareBusy: true, notice: null })
    const capture = await captureScreen(undefined, false)
    if (!capture.ok) {
      const notice =
        capture.problem === 'cancelled' ? (fromTray ? 'fromTray' : null) : capture.problem
      this.#set({ shareBusy: false, notice })
      return
    }
    const track = capture.track
    this.#screen = track
    this.#watchEnd(track)
    // Which screen this is, for remote control's pointer (N4): only a whole screen is aimed at
    await this.#aim(track)
    try {
      await native.setSharing(true)
      await native.send(JSON.stringify({ t: 'share' }))
      const transport = await this.#ensureTransport()
      this.#published = await transport.publish(track, { kind: 'screen', simulcast: true })
      await this.#announceShare(false)
      this.#set({ shareBusy: false })
    } catch {
      await this.stopShare('failed')
    }
  }

  /** The share stops when the system ends its track (not when we replaced it, N5) */
  #watchEnd(track: MediaStreamTrack): void {
    track.addEventListener('ended', () => {
      if (this.#screen === track) void this.stopShare()
    })
  }

  /**
   * 「換一個螢幕」 (N5, e9-t09): the picker again while sharing; the new track takes the old one's
   * place in the same published track (replaceTrack: the room and the viewers keep the same share),
   * and the pointer aims at the new screen. Cancelling the picker keeps the old screen.
   */
  async switchScreen(): Promise<void> {
    const published = this.#published
    const transport = this.#transport
    const old = this.#screen
    if (!published || !transport || !old || this.#view.shareBusy) return
    this.#set({ shareBusy: true, notice: null })
    const capture = await captureScreen(undefined, false)
    if (!capture.ok) {
      this.#set({
        shareBusy: false,
        notice: capture.problem === 'cancelled' ? null : capture.problem,
      })
      return
    }
    const track = capture.track
    try {
      await transport.replaceTrack(published.trackName, track)
    } catch {
      track.stop()
      this.#set({ shareBusy: false, notice: 'failed' })
      return
    }
    this.#screen = track
    this.#watchEnd(track)
    old.stop()
    await this.#aim(track)
    this.#set({ shareBusy: false })
  }

  /** The track list with the screen, after `share` again when coming back from a drop */
  async #announceShare(shareAgain: boolean): Promise<void> {
    const published = this.#published
    const sessionId = this.#transport?.sessionId
    if (!published || !sessionId) return
    if (shareAgain) await native.send(JSON.stringify({ t: 'share' }))
    await native.send(
      JSON.stringify({
        t: 'tracks',
        sessionId,
        tracks: [{ trackName: published.trackName, kind: 'screen', muted: false }],
      }),
    )
  }

  /** 「分享我的螢幕」 off, the track ended, or the room refused the share */
  async stopShare(notice: ShareNotice | null = null): Promise<void> {
    const track = this.#screen
    const published = this.#published
    this.#screen = null
    this.#published = null
    this.#set({ shareBusy: true })
    if (published && this.#transport) {
      await this.#transport.unpublish(published.trackName).catch(() => {})
      const sessionId = this.#transport.sessionId
      if (sessionId) {
        await native.send(JSON.stringify({ t: 'tracks', sessionId, tracks: [] })).catch(() => {})
      }
    }
    await native.send(JSON.stringify({ t: 'unshare' })).catch(() => {})
    await native.setSharing(false).catch(() => {})
    track?.stop()
    await this.#aim(null)
    this.#set({ shareBusy: false, notice })
  }

  async #ensureTransport(): Promise<MediaTransport> {
    const current = this.#transport
    if (current && current.state !== 'failed' && current.state !== 'closed') return current
    if (!this.#room) throw new Error('no room')
    const transport = new CloudflareRealtimeTransport({
      apiBase: sfuApiBase(this.#room),
      // The agent token is added in Rust (api_fetch); the page never has it
      token: () => null,
      fetch: nativeFetch,
    })
    this.#transport = transport
    await transport.connect({ iceServers: await this.#iceServers() })
    return transport
  }

  async #iceServers(): Promise<RTCIceServer[]> {
    if (!this.#room) return [STUN_SERVER]
    try {
      const res = await nativeFetch(turnPath(this.#room), { method: 'POST' })
      const body = (await res.json()) as { iceServers?: unknown }
      return (res.ok && usableIceServers(body.iceServers)) || [STUN_SERVER]
    } catch {
      return [STUN_SERVER]
    }
  }

  /** 離開房間 (also from the tray): the screen stops, Rust sends `leave` and forgets the token */
  async leave(): Promise<void> {
    if (this.#screen) await this.stopShare()
    await native.leave().catch(() => {})
    this.#teardown()
  }

  #teardown(): void {
    this.#stopHeartbeat()
    if (this.#retry !== null) clearTimeout(this.#retry)
    this.#retry = null
    this.#screen?.stop()
    this.#screen = null
    this.#published = null
    void this.#transport?.close()
    this.#transport = null
    if (this.#view.reconnecting || this.#view.shareBusy) {
      this.#set({ reconnecting: false, shareBusy: false })
    }
  }
}
