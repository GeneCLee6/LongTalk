import type {
  ApiError,
  CloseTracksResponse,
  NewSessionResponse,
  SessionDescription,
  SimulcastRid,
  TracksResponse,
} from '../../shared/sfu.ts'
import { TransportEmitter } from './emitter.ts'
import {
  applyDegradation,
  sendEncoding,
  videoSendParameters,
  withStartBitrate,
} from './encoding.ts'
import {
  MediaTransportError,
  trackKey,
  type ConnectOptions,
  type ConnectionState,
  type Layer,
  type MediaTransport,
  type MediaTransportEvent,
  type MediaTransportEvents,
  type MediaTransportErrorCode,
  type PublishOptions,
  type PublishedTrack,
  type RemoteTrack,
  type TrackRef,
  type TransportStats,
  type Unsubscribe,
} from './MediaTransport.ts'

// MediaTransport over Cloudflare Realtime SFU (docs/adr-001-media-layer.md). One SFU session and
// one RTCPeerConnection per participant: publishing pushes local tracks into the session,
// subscribing pulls other sessions' tracks into it. All SFU calls go through the Worker proxy
// (/api/sfu/<roomId>/*, worker/sfu.ts), which holds the App Secret and only serves a member of
// the room: every call carries the member's session token.
//
// B1: publish mic/cam and pull the room's tracks (e2-t03, e2-t04). B3: ICE servers with TURN
// credentials from the Worker (e2-t07, ConnectOptions) and refreshed ones (setIceServers);
// `disconnected` is reported as `reconnecting` and `failed` as `failed`, and RoomMedia rebuilds
// the session (e2-t08). Simulcast publishing (e2-t11) builds on it.
//
// Negotiation rules, learned in rooms of three or more (docs/adr-001-media-layer.md):
// - one SDP exchange at a time per session (the queue); an exchange is over only once the SFU's
//   answer is applied, or our answer to the SFU's offer is accepted by /renegotiate;
// - an SFU offer is answered whenever a response carries one, whatever else it says, or the
//   session waits for that answer and refuses every later call (406);
// - a published track is handed back (and so reported to the room) only once its sender is
//   sending: pulling a track that carries no packets yet fails (empty_track_error);
// - a pulled track's mid is read from the result for that track (publisher session and name);
// - an exchange that broke half-way leaves the browser and the SFU disagreeing about the SDP:
//   the transport goes `failed`, so that RoomMedia builds a new session instead of retrying calls
//   that can only be refused.

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }]
// Realtime expects complete SDP (no trickle ICE); gathering rarely needs this long
const ICE_GATHERING_TIMEOUT_MS = 1500
/**
 * How long publish() waits for a new track's first packets (normally a few hundred ms after the
 * answer, a second or two through TURN) before taking the connection for broken
 */
export const FIRST_PACKETS_TIMEOUT_MS = 10_000
const FIRST_PACKETS_POLL_MS = 100
/** How long a pulled track's transceiver may take to show up when the SFU sent no offer */
const TRANSCEIVER_TIMEOUT_MS = 3_000

const LAYER_RID: Record<Layer, SimulcastRid> = { high: 'f', medium: 'h', low: 'q' }

export interface CloudflareRealtimeOptions {
  /** Base of the Worker proxy for the room, `/api/sfu/<roomId>` (shared/sfu.ts sfuApiBase) */
  apiBase: string
  /** The member's session token from the room's `welcome`, sent as a bearer token */
  token: () => string | null
  fetch?: typeof fetch
  createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection
  /** Wait for a published track's first packets at most this long (FIRST_PACKETS_TIMEOUT_MS) */
  firstPacketsTimeoutMs?: number
}

interface Subscription extends RemoteTrack {
  mid: string
}

export class CloudflareRealtimeTransport implements MediaTransport {
  sessionId: string | null = null
  state: ConnectionState = 'new'

  #apiBase: string
  #fetch: typeof fetch
  #createPc: (config: RTCConfiguration) => RTCPeerConnection
  #pc: RTCPeerConnection | null = null
  #emitter = new TransportEmitter()
  // Realtime allows one SDP exchange at a time per session: every mutation runs in this queue
  #queue: Promise<unknown> = Promise.resolve()
  #published = new Map<string, RTCRtpTransceiver>()
  #subscriptions = new Map<string, Subscription>()

  #token: () => string | null
  #firstPacketsTimeoutMs: number

  constructor(options: CloudflareRealtimeOptions) {
    this.#apiBase = options.apiBase
    this.#token = options.token
    this.#firstPacketsTimeoutMs = options.firstPacketsTimeoutMs ?? FIRST_PACKETS_TIMEOUT_MS
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.#createPc = options.createPeerConnection ?? ((config) => new RTCPeerConnection(config))
  }

  async connect(options: ConnectOptions = {}): Promise<void> {
    if (this.state === 'closed') throw new MediaTransportError('closed')
    if (this.#pc) return
    this.#setState('connecting')
    const pc = this.#createPc({
      iceServers: options.iceServers ?? DEFAULT_ICE_SERVERS,
      iceTransportPolicy: options.iceTransportPolicy ?? 'all',
      bundlePolicy: 'max-bundle',
    })
    this.#pc = pc
    pc.addEventListener('connectionstatechange', () => this.#onPcState(pc.connectionState))
    try {
      const res = await this.#api<NewSessionResponse>('POST', '/sessions')
      this.sessionId = res.sessionId
    } catch (error) {
      pc.close()
      this.#pc = null
      this.#setState('failed')
      throw error
    }
    // The PeerConnection only starts connecting with the first publish or subscribe; until
    // then the session exists and calls can be made, which is what callers wait for.
    this.#setState('connected')
  }

  async publish(track: MediaStreamTrack, options: PublishOptions): Promise<PublishedTrack> {
    const { published, transceiver } = await this.#serial(async () => {
      const { pc, sessionId } = this.#require()
      const simulcast = options.simulcast && track.kind === 'video'
      // Bitrate, frame rate and priority by kind (encoding.ts, measured in ADR-001)
      const video = track.kind === 'video' ? videoSendParameters(options.kind) : null
      const transceiver = pc.addTransceiver(track, {
        direction: 'sendonly',
        sendEncodings: simulcast
          ? [
              { rid: 'f', scaleResolutionDownBy: 1 },
              { rid: 'h', scaleResolutionDownBy: 2 },
              { rid: 'q', scaleResolutionDownBy: 4 },
            ]
          : video
            ? [sendEncoding(video)]
            : undefined,
      })
      if (track.kind === 'video') sendVp8(transceiver)
      const trackName = `${options.kind}-${crypto.randomUUID().slice(0, 8)}`
      let answer: SessionDescription
      try {
        const offer = await this.#localOffer(pc)
        const mid = transceiver.mid
        if (!mid) throw new MediaTransportError('negotiation_failed', 'Transceiver has no mid')
        const res = await this.#api<TracksResponse>('POST', `/sessions/${sessionId}/tracks`, {
          sessionDescription: offer,
          tracks: [{ location: 'local', mid, trackName }],
        })
        assertTracksOk(res)
        if (!res.sessionDescription)
          throw new MediaTransportError('negotiation_failed', 'No answer')
        answer = res.sessionDescription
      } catch (error) {
        // Refused (no video this month) or failed: the SFU took no offer, so take ours back and
        // stop the sender
        await discard(pc, transceiver)
        throw error
      }
      // The SFU accepted the offer: from here a failure leaves the two sides disagreeing
      // The answer's VP8 gets a start bitrate for our sender (local only, encoding.ts)
      const remote = video ? { type: answer.type, sdp: withStartBitrate(answer.sdp) } : answer
      await this.#exchange(() => pc.setRemoteDescription(remote))
      if (video) await applyDegradation(transceiver.sender, video)
      this.#published.set(trackName, transceiver)
      const published: PublishedTrack = { sessionId, trackName, kind: options.kind }
      return { published, transceiver }
    })
    // Outside the queue: other calls go on while the first packets are on their way
    await this.#firstPackets(transceiver)
    return published
  }

  unpublish(trackName: string): Promise<void> {
    return this.#serial(async () => {
      const transceiver = this.#published.get(trackName)
      if (!transceiver?.mid) return
      this.#published.delete(trackName)
      await this.#closeTransceivers([transceiver])
    })
  }

  async replaceTrack(trackName: string, track: MediaStreamTrack | null): Promise<void> {
    this.#require()
    const transceiver = this.#published.get(trackName)
    if (!transceiver) throw new MediaTransportError('not_found', `Not published: ${trackName}`)
    // RTCRtpSender.replaceTrack needs no SDP exchange, so it does not wait for the queue
    await transceiver.sender.replaceTrack(track)
  }

  subscribe(ref: TrackRef): Promise<RemoteTrack> {
    return this.#serial(async () => {
      const existing = this.#subscriptions.get(trackKey(ref))
      if (existing) return toRemote(existing)
      const { pc, sessionId } = this.#require()
      const { res, json } = await this.#request<TracksResponse>(
        'POST',
        `/sessions/${sessionId}/tracks`,
        { tracks: [{ location: 'remote', sessionId: ref.sessionId, trackName: ref.trackName }] },
      )
      // Realtime can ask for a renegotiation even when the track itself failed (empty_track_error:
      // the publisher is not sending yet), or the call as a whole. The session then waits for our
      // answer and refuses every other call until it gets one (406; found by the e2e test, e2-t10,
      // and in rooms of three): answer first, then look at the result
      const offer = json.sessionDescription
      if (json.requiresImmediateRenegotiation && offer?.type === 'offer') {
        await this.#exchange(() => this.#answer(pc, sessionId, offer))
      }
      this.#check(res, json)
      const result =
        json.tracks?.find((t) => t.sessionId === ref.sessionId && t.trackName === ref.trackName) ??
        (json.tracks?.length === 1 ? json.tracks[0] : undefined)
      if (result) assertTracksOk({ tracks: [result] })
      const mid = result?.mid
      if (!mid) throw new MediaTransportError('not_found', `No track ${trackKey(ref)}`)
      const transceiver = await this.#transceiver(pc, mid)
      if (!transceiver) {
        // The SFU put the track on a mid this PeerConnection does not have: the two sides no
        // longer agree on the SDP, and only a new session puts that right
        this.#setState('failed')
        throw new MediaTransportError('negotiation_failed', `No transceiver ${mid}`)
      }
      const subscription: Subscription = { ...ref, mid, track: transceiver.receiver.track }
      this.#subscriptions.set(trackKey(ref), subscription)
      const remote = toRemote(subscription)
      this.#emitter.emit('track', remote)
      return remote
    })
  }

  unsubscribe(ref: TrackRef): Promise<void> {
    return this.#serial(async () => {
      const subscription = this.#subscriptions.get(trackKey(ref))
      if (!subscription) return
      this.#subscriptions.delete(trackKey(ref))
      const transceiver = this.#pc?.getTransceivers().find((t) => t.mid === subscription.mid)
      if (transceiver) await this.#closeTransceivers([transceiver])
      this.#emitter.emit('trackEnded', { sessionId: ref.sessionId, trackName: ref.trackName })
    })
  }

  setPreferredLayer(ref: TrackRef, layer: Layer): Promise<void> {
    return this.#serial(async () => {
      const { sessionId } = this.#require()
      const subscription = this.#subscriptions.get(trackKey(ref))
      if (!subscription)
        throw new MediaTransportError('not_found', `Not subscribed to ${trackKey(ref)}`)
      const res = await this.#api<TracksResponse>('PUT', `/sessions/${sessionId}/tracks/update`, {
        tracks: [
          {
            location: 'remote',
            mid: subscription.mid,
            sessionId: ref.sessionId,
            trackName: ref.trackName,
            simulcast: {
              preferredRid: LAYER_RID[layer],
              priorityOrdering: 'asciibetical',
              ridNotAvailable: 'asciibetical',
            },
          },
        ],
      })
      assertTracksOk(res)
    })
  }

  async getStats(): Promise<TransportStats> {
    const { pc } = this.#require()
    const report = await pc.getStats()
    const stats: TransportStats = { rttMs: null, usingRelay: false, bytesSent: 0, bytesReceived: 0 }
    const byId = new Map<string, Record<string, unknown>>()
    report.forEach((entry: Record<string, unknown>) => byId.set(String(entry.id), entry))
    for (const entry of byId.values()) {
      if (
        entry.type !== 'candidate-pair' ||
        entry.nominated !== true ||
        entry.state !== 'succeeded'
      ) {
        continue
      }
      if (typeof entry.currentRoundTripTime === 'number')
        stats.rttMs = entry.currentRoundTripTime * 1000
      stats.bytesSent = Number(entry.bytesSent ?? 0)
      stats.bytesReceived = Number(entry.bytesReceived ?? 0)
      const local = byId.get(String(entry.localCandidateId))
      stats.usingRelay = local?.candidateType === 'relay'
    }
    return stats
  }

  setIceServers(iceServers: RTCIceServer[]): void {
    const pc = this.#pc
    if (!pc || this.state === 'closed') return
    try {
      pc.setConfiguration({ ...pc.getConfiguration(), iceServers })
    } catch {
      // Refused (a closed connection): the next session asks for new servers anyway
    }
  }

  on<E extends MediaTransportEvent>(
    event: E,
    handler: (payload: MediaTransportEvents[E]) => void,
  ): Unsubscribe {
    return this.#emitter.on(event, handler)
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return
    // Closing the PeerConnection ends the session's tracks on the SFU; nothing else to call
    this.#pc?.close()
    this.#pc = null
    for (const subscription of this.#subscriptions.values()) {
      this.#emitter.emit('trackEnded', {
        sessionId: subscription.sessionId,
        trackName: subscription.trackName,
      })
    }
    this.#subscriptions.clear()
    this.#published.clear()
    this.#setState('closed')
    this.#emitter.clear()
  }

  // Negotiated close (Realtime "Closing tracks"): stop the transceivers, send our offer, apply
  // the answer
  async #closeTransceivers(transceivers: RTCRtpTransceiver[]): Promise<void> {
    const { pc, sessionId } = this.#require()
    const mids = transceivers.map((t) => t.mid).filter((mid): mid is string => mid !== null)
    for (const transceiver of transceivers) transceiver.stop()
    const offer = await this.#localOffer(pc)
    let res: CloseTracksResponse
    try {
      res = await this.#api<CloseTracksResponse>('PUT', `/sessions/${sessionId}/tracks/close`, {
        tracks: mids.map((mid) => ({ mid })),
        sessionDescription: offer,
        force: false,
      })
    } catch (error) {
      // The SFU took no offer: take ours back so that the next exchange starts from stable
      if (pc.signalingState === 'have-local-offer') {
        await pc.setLocalDescription({ type: 'rollback' }).catch(() => undefined)
      }
      throw error
    }
    const answer = res.sessionDescription
    if (answer) await this.#exchange(() => pc.setRemoteDescription(answer))
  }

  async #localOffer(pc: RTCPeerConnection): Promise<SessionDescription> {
    await pc.setLocalDescription(await pc.createOffer())
    await waitForIceGathering(pc)
    return toSessionDescription(pc.localDescription)
  }

  async #answer(
    pc: RTCPeerConnection,
    sessionId: string,
    offer: SessionDescription,
  ): Promise<void> {
    await pc.setRemoteDescription(offer)
    await pc.setLocalDescription(await pc.createAnswer())
    await waitForIceGathering(pc)
    await this.#api('PUT', `/sessions/${sessionId}/renegotiate`, {
      sessionDescription: toSessionDescription(pc.localDescription),
    })
  }

  async #api<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
    const { res, json } = await this.#request<T>(method, path, body)
    this.#check(res, json)
    return json
  }

  /** One call to the proxy; what the response means is #check's business */
  async #request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
  ): Promise<{ res: Response; json: T & ApiError & { error?: string } }> {
    const headers: Record<string, string> = {}
    const token = this.#token()
    if (token) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await this.#fetch(`${this.#apiBase}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as T & ApiError & { error?: string }
    return { res, json }
  }

  /** Throws the error a response stands for, and fails the transport when the session is unusable */
  #check(res: Response, json: ApiError & { error?: string }): void {
    const proxyError = PROXY_ERRORS[json.error ?? '']
    if (!res.ok && proxyError) throw new MediaTransportError(proxyError, json.error)
    // The SFU no longer has a usable session (session_error), or its idea of the SDP state is not
    // ours (406: it still expects an answer, or the offer/answer order is off): fail, so that
    // RoomMedia builds a new session instead of retrying calls that it will refuse them all
    if (json.errorCode === 'session_error' || res.status === 406) this.#setState('failed')
    if (!res.ok || json.errorCode) {
      const detail = [json.errorCode ?? json.error, json.errorDescription].filter(Boolean)
      throw new MediaTransportError('sfu_error', `${res.status} ${detail.join(': ')}`)
    }
  }

  /**
   * One step of an SDP exchange the SFU already took part in. Should it fail, the browser and the
   * SFU disagree about the session description from then on: the transport fails (to be rebuilt).
   */
  async #exchange(step: () => Promise<unknown>): Promise<void> {
    try {
      await step()
    } catch (error) {
      if (this.state !== 'closed') this.#setState('failed')
      throw error instanceof MediaTransportError
        ? error
        : new MediaTransportError('negotiation_failed', String(error))
    }
  }

  /**
   * The transceiver the SFU put a pulled track on: there once its offer is applied. When the SFU
   * sent no offer, the browser gets a moment to show it.
   */
  async #transceiver(pc: RTCPeerConnection, mid: string): Promise<RTCRtpTransceiver | null> {
    const find = () => pc.getTransceivers().find((t) => t.mid === mid) ?? null
    const found = find()
    if (found) return found
    return new Promise((resolve) => {
      const done = (value: RTCRtpTransceiver | null) => {
        clearTimeout(timer)
        pc.removeEventListener('track', onTrack)
        resolve(value)
      }
      const onTrack = () => {
        const transceiver = find()
        if (transceiver) done(transceiver)
      }
      const timer = setTimeout(() => done(find()), TRANSCEIVER_TIMEOUT_MS)
      pc.addEventListener('track', onTrack)
    })
  }

  /**
   * Resolves once a published track's sender has sent its first packets. Until then the SFU has
   * nothing to forward: a subscriber pulling it waits several seconds and gets
   * `empty_track_error`, holding up its own session's queue (Cloudflare's partytracks client
   * waits the same way). A sender that sends nothing for FIRST_PACKETS_TIMEOUT_MS sits on a
   * connection that never came up: the transport fails, to be rebuilt.
   */
  async #firstPackets(transceiver: RTCRtpTransceiver): Promise<void> {
    const sender = transceiver.sender as RTCRtpSender | undefined
    if (typeof sender?.getStats !== 'function') return
    const deadline = Date.now() + this.#firstPacketsTimeoutMs
    for (;;) {
      if (this.state === 'closed') throw new MediaTransportError('closed')
      if (this.state === 'failed') throw new MediaTransportError('negotiation_failed', 'Failed')
      if (await hasSent(sender)) return
      if (Date.now() >= deadline) {
        this.#setState('failed')
        throw new MediaTransportError('negotiation_failed', 'No packets sent')
      }
      await new Promise((resolve) => setTimeout(resolve, FIRST_PACKETS_POLL_MS))
    }
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task)
    this.#queue = run.catch(() => undefined)
    return run
  }

  #require(): { pc: RTCPeerConnection; sessionId: string } {
    if (this.state === 'closed') throw new MediaTransportError('closed')
    if (!this.#pc || !this.sessionId) throw new MediaTransportError('not_connected')
    return { pc: this.#pc, sessionId: this.sessionId }
  }

  #onPcState(pcState: RTCPeerConnectionState): void {
    if (this.state === 'closed' || this.state === 'failed') return
    if (pcState === 'connected') this.#setState('connected')
    else if (pcState === 'disconnected') this.#setState('reconnecting')
    else if (pcState === 'failed') this.#setState('failed')
  }

  #setState(state: ConnectionState): void {
    if (this.state === state) return
    this.state = state
    this.#emitter.emit('state', state)
  }
}

/** The Worker proxy's own refusals (shared/sfu.ts SfuProxyError), as transport errors */
const PROXY_ERRORS: Partial<Record<string, MediaTransportErrorCode>> = {
  sfu_not_configured: 'sfu_not_configured',
  unauthorized: 'unauthorized',
  forbidden: 'unauthorized',
  usage_audio_only: 'quota_exceeded',
  track_not_in_room: 'not_found',
}

/**
 * Offers VP8 (and its retransmission) only on a camera or screen we send. With several codecs,
 * once the PeerConnection already receives video from others, Chrome numbers the new section's
 * payload types afresh and the SFU's answer uses the numbers of the sections it offered earlier
 * (H264 125 for the offer's 97, VP9's RTX 36 for 99): payload types the offer never had, and the
 * browser refuses the answer ("Failed to set remote video description send parameters"). Found
 * with the third member of a room (two cameras pulled, then its own pushed), every time in
 * Playwright's headless Chromium. With VP8 alone the answer keeps the offer's numbers, and every
 * browser decodes VP8.
 */
function sendVp8(transceiver: RTCRtpTransceiver): void {
  if (typeof RTCRtpSender === 'undefined' || !transceiver.setCodecPreferences) return
  const codecs = (RTCRtpSender.getCapabilities?.('video')?.codecs ?? []).filter((codec) =>
    /^video\/(vp8|rtx)$/i.test(codec.mimeType),
  )
  if (!codecs.some((codec) => /vp8$/i.test(codec.mimeType))) return
  try {
    transceiver.setCodecPreferences(codecs)
  } catch {
    // Not supported here: the browser offers its own list
  }
}

async function hasSent(sender: RTCRtpSender): Promise<boolean> {
  try {
    const report = await sender.getStats()
    let sent = false
    report.forEach((entry: Record<string, unknown>) => {
      if (entry.type === 'outbound-rtp' && Number(entry.bytesSent ?? 0) > 0) sent = true
    })
    return sent
  } catch {
    return false
  }
}

async function discard(pc: RTCPeerConnection, transceiver: RTCRtpTransceiver): Promise<void> {
  try {
    if (pc.signalingState === 'have-local-offer') {
      await pc.setLocalDescription({ type: 'rollback' })
    }
    transceiver.stop()
  } catch {
    // The PeerConnection is closing; nothing to take back
  }
}

/** Per-track errors that mean "not there (yet)": the subscription is retried, not an alarm */
const TRACK_NOT_READY = new Set(['track_not_found', 'not_found_track_error', 'empty_track_error'])

function assertTracksOk(res: TracksResponse): void {
  const failed = res.tracks?.find((t) => t.errorCode)
  if (failed) {
    const code = TRACK_NOT_READY.has(failed.errorCode ?? '') ? 'not_found' : 'sfu_error'
    throw new MediaTransportError(code, `${failed.errorCode}: ${failed.errorDescription ?? ''}`)
  }
}

function toRemote(subscription: Subscription): RemoteTrack {
  return {
    sessionId: subscription.sessionId,
    trackName: subscription.trackName,
    track: subscription.track,
  }
}

function toSessionDescription(description: RTCSessionDescription | null): SessionDescription {
  if (!description || (description.type !== 'offer' && description.type !== 'answer')) {
    throw new MediaTransportError('negotiation_failed', 'No local description')
  }
  return { type: description.type, sdp: description.sdp }
}

function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', check)
      resolve()
    }
    const check = () => {
      if (pc.iceGatheringState === 'complete') done()
    }
    const timer = setTimeout(done, ICE_GATHERING_TIMEOUT_MS)
    pc.addEventListener('icegatheringstatechange', check)
  })
}
