// The recording's sound (I4, e8-t01): every microphone and share sound in the room mixed into one
// track with Web Audio, the way the recorder hears the meeting (the others, their shares, our own
// microphone). The set of tracks changes during a meeting; `sync` connects what is new and lets
// go of what left, so nothing piles up over an hour.

/** The bits of AudioContext the mixer uses (a fake in tests) */
export interface MixerContext {
  createMediaStreamSource(stream: MediaStream): {
    connect(node: never): unknown
    disconnect(): void
  }
  createMediaStreamDestination(): { stream: MediaStream }
}

interface Source {
  node: { disconnect(): void }
  track: MediaStreamTrack
}

export class AudioMixer {
  private readonly context: MixerContext
  private readonly destination: { stream: MediaStream }
  private readonly sources = new Map<string, Source>()
  private readonly makeStream: (track: MediaStreamTrack) => MediaStream

  constructor(
    context: MixerContext,
    makeStream: (track: MediaStreamTrack) => MediaStream = (track) => new MediaStream([track]),
  ) {
    this.context = context
    this.makeStream = makeStream
    this.destination = context.createMediaStreamDestination()
  }

  /** The mixed sound: what MediaRecorder records */
  get track(): MediaStreamTrack {
    return this.destination.stream.getAudioTracks()[0]
  }

  /** How many tracks are mixed now */
  get size(): number {
    return this.sources.size
  }

  /** Mixes exactly `tracks` (by id) from now on; ended tracks are let go */
  sync(tracks: readonly MediaStreamTrack[]): void {
    const wanted = new Map<string, MediaStreamTrack>()
    for (const track of tracks) {
      if (track.kind === 'audio' && track.readyState !== 'ended') wanted.set(track.id, track)
    }
    for (const [id, source] of this.sources) {
      if (wanted.get(id) === source.track) continue
      source.node.disconnect()
      this.sources.delete(id)
    }
    for (const [id, track] of wanted) {
      if (this.sources.has(id)) continue
      try {
        const node = this.context.createMediaStreamSource(this.makeStream(track))
        node.connect(this.destination as never)
        this.sources.set(id, { node, track })
      } catch {
        // A track the context cannot take (gone meanwhile): try again on the next sync
      }
    }
  }

  close(): void {
    for (const source of this.sources.values()) source.node.disconnect()
    this.sources.clear()
  }
}
