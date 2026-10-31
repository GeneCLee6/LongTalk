import type {
  CloseTracksResponse,
  NewSessionResponse,
  SessionDescription,
  SimulcastRid,
  TracksResponse,
} from '../../shared/sfu.ts'
import { TransportEmitter } from './emitter.ts'
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
// B1: publish mic/cam and pull the room's tracks (e2-t03, e2-t04). Reconnection (e2-t08), TURN
// credentials (e2-t07) and simulcast publishing (e2-t11) build on it.

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }]
// Realtime expects complete SDP (no trickle ICE); gathering rarely needs this long
const ICE_GATHERING_TIMEOUT_MS = 1500

const LAYER_RID: Record<Layer, SimulcastRid> = { high: 'f', medium: 'h', low: 'q' }

export interface CloudflareRealtimeOptions {
  /** Base of the Worker proxy for the room, `/api/sfu/<roomId>` (shared/sfu.ts sfuApiBase) */
  apiBase: string
  /** The member's session token from the room's `welcome`, sent as a bearer token */
  token: () => string | null
  fetch?: typeof fetch
  createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection
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

  constructor(options: CloudflareRealtimeOptions) {
    this.#apiBase = options.apiBase
    this.#token = options.token
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.#createPc = options.createPeerConnection ?? ((config) => new RTCPeerConnection(config))
  }

  async connect(options: ConnectOptions = {}): Promise<void> {
    if (this.state === 'closed') throw new MediaTransportError('closed')
    if (this.#pc) return
    this.#setState('connecting')
    const pc = this.#createPc({
      iceServers: options.iceServers ?? DEFAULT_ICE_SERVERS,
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

  publish(track: MediaStreamTrack, options: PublishOptions): Promise<PublishedTrack> {
    return this.#serial(async () => {
      const { pc, sessionId } = this.#require()
      const simulcast = options.simulcast && track.kind === 'video'
      const transceiver = pc.addTransceiver(track, {
        direction: 'sendonly',
        sendEncodings: simulcast
          ? [
              { rid: 'f', scaleResolutionDownBy: 1 },
              { rid: 'h', scaleResolutionDownBy: 2 },
              { rid: 'q', scaleResolutionDownBy: 4 },
            ]
          : undefined,
      })
      try {
        const offer = await this.#localOffer(pc)
        const mid = transceiver.mid
        if (!mid) throw new MediaTransportError('negotiation_failed', 'Transceiver has no mid')
        const trackName = `${options.kind}-${crypto.randomUUID().slice(0, 8)}`
        const res = await this.#api<TracksResponse>('POST', `/sessions/${sessionId}/tracks`, {
          sessionDescription: offer,
          tracks: [{ location: 'local', mid, trackName }],
        })
        assertTracksOk(res)
        if (!res.sessionDescription)
          throw new MediaTransportError('negotiation_failed', 'No answer')
        await pc.setRemoteDescription(res.sessionDescription)
        this.#published.set(trackName, transceiver)
        return { sessionId, trackName, kind: options.kind }
      } catch (error) {
        // Refused (no video this month) or failed: take the offer back and stop the sender
        await discard(pc, transceiver)
        throw error
      }
    })
  }

  unpublish(trackName: string): Promise<void> {
    return this.#serial(async () => {
      const transceiver = this.#published.get(trackName)
      if (!transceiver?.mid) return
      this.#published.delete(trackName)
      await this.#closeTransceivers([transceiver])
    })
  }

  subscribe(ref: TrackRef): Promise<RemoteTrack> {
    return this.#serial(async () => {
      const existing = this.#subscriptions.get(trackKey(ref))
      if (existing) return toRemote(existing)
      const { pc, sessionId } = this.#require()
      const res = await this.#api<TracksResponse>('POST', `/sessions/${sessionId}/tracks`, {
        tracks: [{ location: 'remote', sessionId: ref.sessionId, trackName: ref.trackName }],
      })
      assertTracksOk(res)
      const mid = res.tracks?.[0]?.mid
      if (!mid) throw new MediaTransportError('not_found', `No track ${trackKey(ref)}`)
      if (res.requiresImmediateRenegotiation && res.sessionDescription) {
        await this.#answer(pc, sessionId, res.sessionDescription)
      }
      const transceiver = pc.getTransceivers().find((t) => t.mid === mid)
      if (!transceiver) throw new MediaTransportError('negotiation_failed', `No transceiver ${mid}`)
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
    const res = await this.#api<CloseTracksResponse>('PUT', `/sessions/${sessionId}/tracks/close`, {
      tracks: mids.map((mid) => ({ mid })),
      sessionDescription: offer,
      force: false,
    })
    if (res.sessionDescription) await pc.setRemoteDescription(res.sessionDescription)
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
    const headers: Record<string, string> = {}
    const token = this.#token()
    if (token) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await this.#fetch(`${this.#apiBase}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as T & { error?: string; errorCode?: string }
    const proxyError = PROXY_ERRORS[json.error ?? '']
    if (!res.ok && proxyError) throw new MediaTransportError(proxyError, json.error)
    if (!res.ok || json.errorCode) {
      throw new MediaTransportError(
        'sfu_error',
        `${res.status} ${json.errorCode ?? json.error ?? ''}`,
      )
    }
    return json
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
    if (this.state === 'closed') return
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

function assertTracksOk(res: TracksResponse): void {
  const failed = res.tracks?.find((t) => t.errorCode)
  if (failed) {
    const code = failed.errorCode === 'track_not_found' ? 'not_found' : 'sfu_error'
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
