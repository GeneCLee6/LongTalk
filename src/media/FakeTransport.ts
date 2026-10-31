import { TransportEmitter } from './emitter.ts'
import {
  MediaTransportError,
  trackKey,
  type ConnectionState,
  type Layer,
  type MediaTransport,
  type MediaTransportEvent,
  type MediaTransportEvents,
  type PublishOptions,
  type PublishedTrack,
  type RemoteTrack,
  type TrackRef,
  type TransportStats,
  type Unsubscribe,
} from './MediaTransport.ts'

/**
 * An in-memory SFU for tests: transports created from the same FakeSfu can publish to and
 * subscribe from each other, so useRoomMedia (e2-t04) and the room page can be tested without
 * WebRTC. Remote tracks are the publisher's own MediaStreamTrack objects.
 */
export class FakeSfu {
  readonly published = new Map<string, PublishedTrack & { track: MediaStreamTrack }>()
  readonly transports = new Set<FakeTransport>()
  /** Refuse new video tracks like the proxy does once the month is audio-only (e11-t13) */
  refuseVideo = false
  #nextSession = 1

  createTransport(): FakeTransport {
    return new FakeTransport(this)
  }

  /** @internal */
  allocateSessionId(): string {
    return `fake-session-${this.#nextSession++}`
  }

  /** @internal Tell every subscriber that a track is gone */
  trackRemoved(ref: TrackRef): void {
    for (const transport of this.transports) transport.remoteEnded(ref)
  }
}

export class FakeTransport implements MediaTransport {
  readonly sfu: FakeSfu
  sessionId: string | null = null
  state: ConnectionState = 'new'
  /** Layers asked for via setPreferredLayer, by trackKey */
  readonly preferredLayers = new Map<string, Layer>()
  readonly subscriptions = new Map<string, RemoteTrack>()
  /** What getStats() reports as received; tests move it forward */
  bytesReceived = 0
  #emitter = new TransportEmitter()
  #ownTracks = new Set<string>()
  #nextTrack = 1

  constructor(sfu: FakeSfu) {
    this.sfu = sfu
  }

  async connect(): Promise<void> {
    this.#assertOpen()
    if (this.sessionId) return
    this.#setState('connecting')
    this.sessionId = this.sfu.allocateSessionId()
    this.sfu.transports.add(this)
    this.#setState('connected')
  }

  async publish(track: MediaStreamTrack, options: PublishOptions): Promise<PublishedTrack> {
    const sessionId = this.#requireSession()
    if (this.sfu.refuseVideo && (options.kind === 'cam' || options.kind === 'screen')) {
      throw new MediaTransportError('quota_exceeded', 'usage_audio_only')
    }
    const published: PublishedTrack = {
      sessionId,
      trackName: `${options.kind}-${this.#nextTrack++}`,
      kind: options.kind,
    }
    this.sfu.published.set(trackKey(published), { ...published, track })
    this.#ownTracks.add(published.trackName)
    return published
  }

  async unpublish(trackName: string): Promise<void> {
    const sessionId = this.#requireSession()
    if (!this.#ownTracks.delete(trackName)) return
    const ref = { sessionId, trackName }
    this.sfu.published.delete(trackKey(ref))
    this.sfu.trackRemoved(ref)
  }

  async subscribe(ref: TrackRef): Promise<RemoteTrack> {
    this.#requireSession()
    const existing = this.subscriptions.get(trackKey(ref))
    if (existing) return existing
    const source = this.sfu.published.get(trackKey(ref))
    if (!source) throw new MediaTransportError('not_found', `No published track ${trackKey(ref)}`)
    const remote: RemoteTrack = {
      sessionId: ref.sessionId,
      trackName: ref.trackName,
      track: source.track,
    }
    this.subscriptions.set(trackKey(ref), remote)
    this.#emitter.emit('track', remote)
    return remote
  }

  async unsubscribe(ref: TrackRef): Promise<void> {
    this.#requireSession()
    this.remoteEnded(ref)
  }

  async setPreferredLayer(ref: TrackRef, layer: Layer): Promise<void> {
    this.#requireSession()
    if (!this.subscriptions.has(trackKey(ref))) {
      throw new MediaTransportError('not_found', `Not subscribed to ${trackKey(ref)}`)
    }
    this.preferredLayers.set(trackKey(ref), layer)
  }

  async getStats(): Promise<TransportStats> {
    this.#requireSession()
    return { rttMs: 0, usingRelay: false, bytesSent: 0, bytesReceived: this.bytesReceived }
  }

  on<E extends MediaTransportEvent>(
    event: E,
    handler: (payload: MediaTransportEvents[E]) => void,
  ): Unsubscribe {
    return this.#emitter.on(event, handler)
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return
    if (this.sessionId) {
      for (const trackName of [...this.#ownTracks]) await this.unpublish(trackName)
    }
    this.subscriptions.clear()
    this.sfu.transports.delete(this)
    this.#setState('closed')
    this.#emitter.clear()
  }

  /** Test hook: simulate the network dropping and coming back */
  simulateState(state: ConnectionState): void {
    this.#setState(state)
  }

  /** @internal */
  remoteEnded(ref: TrackRef): void {
    if (this.subscriptions.delete(trackKey(ref))) {
      this.preferredLayers.delete(trackKey(ref))
      this.#emitter.emit('trackEnded', { sessionId: ref.sessionId, trackName: ref.trackName })
    }
  }

  #setState(state: ConnectionState): void {
    if (this.state === state) return
    this.state = state
    this.#emitter.emit('state', state)
  }

  #assertOpen(): void {
    if (this.state === 'closed') throw new MediaTransportError('closed')
  }

  #requireSession(): string {
    this.#assertOpen()
    if (!this.sessionId) throw new MediaTransportError('not_connected')
    return this.sessionId
  }
}
