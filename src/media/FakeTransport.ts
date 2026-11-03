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
  type PublishOptions,
  type PublishedTrack,
  type RemoteTrack,
  type SubscribeOptions,
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
  /** The layer each subscription asks for now (subscribe's, then setPreferredLayer's), by trackKey */
  readonly preferredLayers = new Map<string, Layer>()
  /** Every setPreferredLayer call that changed a layer, in order */
  readonly layerRequests: { key: string; layer: Layer }[] = []
  /** What publish() was asked for, by trackName (simulcast or not) */
  readonly publishOptions = new Map<string, PublishOptions>()
  readonly subscriptions = new Map<string, RemoteTrack>()
  /**
   * What each published track sends now, by trackName (set on publish, changed by replaceTrack;
   * subscribers keep the track they got, like a real receiver keeps its track)
   */
  readonly sending = new Map<string, MediaStreamTrack | null>()
  /** What getStats() reports as received; tests move it forward */
  bytesReceived = 0
  /** What getStats() reports as the path; tests set it (e2-t07) */
  usingRelay = false
  /**
   * The rest of what getStats() reports (e2-t13): tests set the per-track counters (or a function
   * of the time, for a link that degrades) and move them forward
   */
  stats: Partial<TransportStats> | (() => Partial<TransportStats>) = {}
  /** What limitSendLayers asked for, by trackName (e2-t15); absent: every layer */
  readonly sendCeilings = new Map<string, Layer>()
  /** What connect() was given, and the servers setIceServers() handed over since */
  connectOptions: ConnectOptions | null = null
  readonly iceServerUpdates: RTCIceServer[][] = []
  #emitter = new TransportEmitter()
  #ownTracks = new Set<string>()
  #nextTrack = 1

  constructor(sfu: FakeSfu) {
    this.sfu = sfu
  }

  async connect(options: ConnectOptions = {}): Promise<void> {
    this.#assertOpen()
    if (this.sessionId) return
    this.connectOptions = options
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
    this.publishOptions.set(published.trackName, options)
    this.#ownTracks.add(published.trackName)
    this.sending.set(published.trackName, track)
    return published
  }

  async unpublish(trackName: string): Promise<void> {
    const sessionId = this.#requireSession()
    if (!this.#ownTracks.delete(trackName)) return
    this.sending.delete(trackName)
    const ref = { sessionId, trackName }
    this.sfu.published.delete(trackKey(ref))
    this.sfu.trackRemoved(ref)
  }

  async replaceTrack(trackName: string, track: MediaStreamTrack | null): Promise<void> {
    this.#requireSession()
    if (!this.#ownTracks.has(trackName)) {
      throw new MediaTransportError('not_found', `Not published: ${trackName}`)
    }
    this.sending.set(trackName, track)
  }

  async subscribe(ref: TrackRef, options: SubscribeOptions = {}): Promise<RemoteTrack> {
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
    if (options.layer) this.preferredLayers.set(trackKey(ref), options.layer)
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
    if (this.preferredLayers.get(trackKey(ref)) === layer) return
    this.preferredLayers.set(trackKey(ref), layer)
    this.layerRequests.push({ key: trackKey(ref), layer })
  }

  async getStats(): Promise<TransportStats> {
    this.#requireSession()
    const extra = typeof this.stats === 'function' ? this.stats() : this.stats
    return {
      timestamp: Date.now(),
      rttMs: 0,
      usingRelay: this.usingRelay,
      candidateType: this.usingRelay ? 'relay' : 'host',
      protocol: 'udp',
      bytesSent: 0,
      bytesReceived: this.bytesReceived,
      availableOutgoingBitrate: null,
      outbound: [],
      inbound: [],
      ...extra,
    }
  }

  async limitSendLayers(trackName: string, highest: Layer): Promise<void> {
    this.#requireSession()
    if (!this.#ownTracks.has(trackName)) {
      throw new MediaTransportError('not_found', `Not published: ${trackName}`)
    }
    if (highest === 'high') this.sendCeilings.delete(trackName)
    else this.sendCeilings.set(trackName, highest)
  }

  setIceServers(iceServers: RTCIceServer[]): void {
    if (this.sessionId && this.state !== 'closed') this.iceServerUpdates.push(iceServers)
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
