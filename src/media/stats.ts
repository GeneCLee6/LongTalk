// Connection statistics (e2-t13, AC-2.7): reading a PeerConnection's getStats() report into
// TransportStats (cumulative counters per track), and two of those into a StatsSample (rates,
// loss and freezes over the interval between them). Pure functions over plain records: the
// transport hands in the report's entries and which track each mid belongs to, the tests hand
// in synthetic ones. No WebRTC objects, no SDP, nothing secret leaves here.
import type {
  InboundTrackStats,
  OutboundLayerStats,
  OutboundTrackStats,
  TrackKind,
  TrackRef,
  TransportStats,
} from './MediaTransport.ts'

type Entry = Record<string, unknown>

/** Which track a transceiver's mid carries: the transport knows, the report does not */
export interface StatsOwners {
  published: ReadonlyMap<string, { trackName: string; kind: TrackKind }>
  subscribed: ReadonlyMap<string, TrackRef>
}

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
const count = (value: unknown): number => num(value) ?? 0
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** The codec's name from its mimeType (`video/VP8` → `VP8`) */
function codecName(byId: ReadonlyMap<string, Entry>, codecId: unknown): string | null {
  const mime = str(byId.get(String(codecId))?.mimeType)
  return mime ? (mime.split('/')[1] ?? mime) : null
}

/** The selected candidate pair: the transport's, else the nominated pair that succeeded */
function selectedPair(byId: ReadonlyMap<string, Entry>): Entry | null {
  for (const entry of byId.values()) {
    if (entry.type !== 'transport') continue
    const pair = byId.get(String(entry.selectedCandidatePairId))
    if (pair) return pair
  }
  let found: Entry | null = null
  for (const entry of byId.values()) {
    if (
      entry.type === 'candidate-pair' &&
      entry.nominated === true &&
      entry.state === 'succeeded'
    ) {
      found = entry
    }
  }
  return found
}

/** Reads a getStats() report (its entries) into TransportStats */
export function readStatsReport(
  entries: Iterable<Entry>,
  owners: StatsOwners,
  now: number = Date.now(),
): TransportStats {
  const byId = new Map<string, Entry>()
  for (const entry of entries) byId.set(String(entry.id), entry)
  const stats: TransportStats = {
    timestamp: now,
    rttMs: null,
    usingRelay: false,
    candidateType: null,
    protocol: null,
    bytesSent: 0,
    bytesReceived: 0,
    availableOutgoingBitrate: null,
    outbound: [],
    inbound: [],
  }
  const pair = selectedPair(byId)
  if (pair) {
    const rtt = num(pair.currentRoundTripTime)
    if (rtt !== null) stats.rttMs = rtt * 1000
    stats.bytesSent = count(pair.bytesSent)
    stats.bytesReceived = count(pair.bytesReceived)
    stats.availableOutgoingBitrate = num(pair.availableOutgoingBitrate)
    const local = byId.get(String(pair.localCandidateId))
    stats.candidateType = str(local?.candidateType)
    stats.usingRelay = stats.candidateType === 'relay'
    stats.protocol = stats.usingRelay
      ? (str(local?.relayProtocol) ?? str(local?.protocol))
      : str(local?.protocol)
  }

  // What the SFU reports back about what we send, by the outbound-rtp it is about
  const remote = new Map<string, Entry>()
  for (const entry of byId.values()) {
    if (entry.type === 'remote-inbound-rtp') remote.set(String(entry.localId), entry)
  }
  const outbound = new Map<string, OutboundTrackStats & { fractions: number[] }>()
  for (const entry of byId.values()) {
    if (entry.type !== 'outbound-rtp') continue
    const owner = owners.published.get(String(entry.mid))
    if (!owner) continue
    let track = outbound.get(owner.trackName)
    if (!track) {
      track = {
        trackName: owner.trackName,
        kind: owner.kind,
        codec: null,
        bytesSent: 0,
        packetsSent: 0,
        packetsLost: 0,
        fractionLost: null,
        layers: [],
        fractions: [],
      }
      outbound.set(owner.trackName, track)
    }
    track.codec ??= codecName(byId, entry.codecId)
    const layer: OutboundLayerStats = {
      rid: str(entry.rid),
      active: entry.active !== false,
      bytesSent: count(entry.bytesSent),
      packetsSent: count(entry.packetsSent),
      framesEncoded: count(entry.framesEncoded),
      width: num(entry.frameWidth),
      height: num(entry.frameHeight),
      fps: num(entry.framesPerSecond),
      qualityLimitationReason: str(entry.qualityLimitationReason),
    }
    track.layers.push(layer)
    track.bytesSent += layer.bytesSent
    track.packetsSent += layer.packetsSent
    const back = remote.get(String(entry.id))
    if (back) {
      track.packetsLost += Math.max(0, count(back.packetsLost))
      const fraction = num(back.fractionLost)
      if (fraction !== null) track.fractions.push(fraction)
    }
  }
  for (const { fractions, ...track } of outbound.values()) {
    // Highest layer first, as they are sent (f, h, q)
    track.layers.sort((a, b) => (a.rid ?? '').localeCompare(b.rid ?? ''))
    stats.outbound.push({
      ...track,
      fractionLost: fractions.length > 0 ? Math.max(...fractions) : null,
    })
  }

  for (const entry of byId.values()) {
    if (entry.type !== 'inbound-rtp') continue
    const owner = owners.subscribed.get(String(entry.mid))
    if (!owner) continue
    const inbound: InboundTrackStats = {
      sessionId: owner.sessionId,
      trackName: owner.trackName,
      media: entry.kind === 'video' ? 'video' : 'audio',
      codec: codecName(byId, entry.codecId),
      bytesReceived: count(entry.bytesReceived),
      packetsReceived: count(entry.packetsReceived),
      packetsLost: Math.max(0, count(entry.packetsLost)),
      jitter: num(entry.jitter),
      width: num(entry.frameWidth),
      height: num(entry.frameHeight),
      fps: num(entry.framesPerSecond),
      framesDecoded: count(entry.framesDecoded),
      framesDropped: count(entry.framesDropped),
      freezeCount: count(entry.freezeCount),
      totalFreezesDuration: count(entry.totalFreezesDuration),
      jitterBufferDelay: count(entry.jitterBufferDelay),
      jitterBufferEmittedCount: count(entry.jitterBufferEmittedCount),
      concealedSamples: count(entry.concealedSamples),
      totalSamplesReceived: count(entry.totalSamplesReceived),
    }
    stats.inbound.push(inbound)
  }
  return stats
}

// ── Samples: what happened between two snapshots ─────────────────────────────────────────────

export interface OutboundLayerSample {
  rid: string | null
  active: boolean
  width: number | null
  height: number | null
  fps: number | null
  /** Bits per second over the interval; null on the first sample */
  bps: number | null
  qualityLimitationReason: string | null
}

export interface OutboundSample {
  trackName: string
  kind: TrackKind
  codec: string | null
  bps: number | null
  /** Packets the SFU says it lost over the interval / packets sent (0–1); null when unknown */
  lossRate: number | null
  /**
   * The worst reason among the layers still sending (bandwidth, then cpu, then other); none when
   * nothing limits the encoder
   */
  qualityLimitationReason: string | null
  layers: OutboundLayerSample[]
}

export interface InboundSample extends TrackRef {
  media: 'audio' | 'video'
  codec: string | null
  bps: number | null
  /** Lost / (lost + received) over the interval (0–1); null on the first sample or no packets */
  lossRate: number | null
  /** Packets received and lost over the interval */
  packets: number
  lost: number
  jitterMs: number | null
  width: number | null
  height: number | null
  fps: number | null
  /** Over the interval */
  framesDropped: number
  freezes: number
  freezeMs: number
  /** Average time a frame or sample waited in the jitter buffer over the interval */
  jitterBufferMs: number | null
  /** Audio: the share of samples made up for lost packets over the interval (0–1) */
  concealedRatio: number | null
}

export interface StatsSample {
  /** When the later snapshot was read */
  at: number
  /** Since the earlier one; 0 on the first sample */
  intervalMs: number
  rttMs: number | null
  usingRelay: boolean
  candidateType: string | null
  protocol: string | null
  availableOutgoingBitrate: number | null
  sendBps: number | null
  receiveBps: number | null
  outbound: OutboundSample[]
  inbound: InboundSample[]
}

const LIMIT_ORDER = ['bandwidth', 'cpu', 'other']

const rate = (now: number, before: number | undefined, seconds: number): number | null =>
  before === undefined || seconds <= 0 || now < before ? null : ((now - before) * 8) / seconds

const ratio = (part: number, whole: number): number | null =>
  whole > 0 ? Math.min(1, Math.max(0, part / whole)) : null

/**
 * What happened between `prev` and `next` (two readings of the same transport): bitrates, loss,
 * freezes. A counter that went backwards (a new subscription in the old one's place) counts as
 * a first reading.
 */
export function sampleStats(prev: TransportStats | null, next: TransportStats): StatsSample {
  const intervalMs = prev ? Math.max(0, next.timestamp - prev.timestamp) : 0
  const seconds = intervalMs / 1000
  const before = prev && intervalMs > 0 ? prev : null
  const prevOut = new Map(before?.outbound.map((t) => [t.trackName, t]) ?? [])
  const prevIn = new Map(before?.inbound.map((t) => [`${t.sessionId}/${t.trackName}`, t]) ?? [])

  const outbound = next.outbound.map((track): OutboundSample => {
    const was = prevOut.get(track.trackName)
    const fresh = !was || track.packetsSent < was.packetsSent
    const sentDelta = fresh ? 0 : track.packetsSent - was.packetsSent
    const lostDelta = fresh ? 0 : Math.max(0, track.packetsLost - was.packetsLost)
    const wasLayers = new Map(fresh ? [] : was.layers.map((l) => [l.rid, l]))
    const layers = track.layers.map((layer) => ({
      rid: layer.rid,
      active: layer.active,
      width: layer.width,
      height: layer.height,
      fps: layer.fps,
      bps: rate(layer.bytesSent, wasLayers.get(layer.rid)?.bytesSent, seconds),
      qualityLimitationReason: layer.qualityLimitationReason,
    }))
    const reasons = layers
      .filter((l) => l.active && l.qualityLimitationReason)
      .map((l) => l.qualityLimitationReason!)
    const worst = LIMIT_ORDER.find((reason) => reasons.includes(reason))
    return {
      trackName: track.trackName,
      kind: track.kind,
      codec: track.codec,
      bps: fresh ? null : rate(track.bytesSent, was.bytesSent, seconds),
      lossRate: sentDelta > 0 ? ratio(lostDelta, sentDelta) : track.fractionLost,
      qualityLimitationReason: worst ?? (reasons.length > 0 ? 'none' : null),
      layers,
    }
  })

  const inbound = next.inbound.map((track): InboundSample => {
    const was = prevIn.get(`${track.sessionId}/${track.trackName}`)
    const fresh = !was || track.packetsReceived < was.packetsReceived
    const received = fresh ? 0 : track.packetsReceived - was.packetsReceived
    const lost = fresh ? 0 : Math.max(0, track.packetsLost - was.packetsLost)
    const emitted = fresh ? 0 : track.jitterBufferEmittedCount - was.jitterBufferEmittedCount
    const samples = fresh ? 0 : track.totalSamplesReceived - was.totalSamplesReceived
    return {
      sessionId: track.sessionId,
      trackName: track.trackName,
      media: track.media,
      codec: track.codec,
      bps: fresh ? null : rate(track.bytesReceived, was.bytesReceived, seconds),
      lossRate: received + lost > 0 ? ratio(lost, received + lost) : null,
      packets: received,
      lost,
      jitterMs: track.jitter === null ? null : track.jitter * 1000,
      width: track.width,
      height: track.height,
      fps: track.fps,
      framesDropped: fresh ? 0 : Math.max(0, track.framesDropped - was.framesDropped),
      freezes: fresh ? 0 : Math.max(0, track.freezeCount - was.freezeCount),
      freezeMs: fresh
        ? 0
        : Math.max(0, (track.totalFreezesDuration - was.totalFreezesDuration) * 1000),
      jitterBufferMs:
        emitted > 0 ? ((track.jitterBufferDelay - was!.jitterBufferDelay) / emitted) * 1000 : null,
      concealedRatio:
        track.media === 'audio' && samples > 0
          ? ratio(track.concealedSamples - was!.concealedSamples, samples)
          : null,
    }
  })

  return {
    at: next.timestamp,
    intervalMs,
    rttMs: next.rttMs,
    usingRelay: next.usingRelay,
    candidateType: next.candidateType,
    protocol: next.protocol,
    availableOutgoingBitrate: next.availableOutgoingBitrate,
    sendBps: before ? rate(next.bytesSent, before.bytesSent, seconds) : null,
    receiveBps: before ? rate(next.bytesReceived, before.bytesReceived, seconds) : null,
    outbound,
    inbound,
  }
}
