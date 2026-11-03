import { useSyncExternalStore, type ReactNode } from 'react'
import styled from 'styled-components'
import type { TrackKind } from '../../shared/protocol.ts'
import type { Layer } from '../media/MediaTransport.ts'
import type { InboundSample, OutboundSample, StatsSample } from '../media/stats.ts'
import type { StatsSnapshot, StatsStore } from '../room/statsStore.ts'
import type { NoiseLoadStore, NoiseStatus } from '../room/useNoiseSuppression.ts'
import { strings } from '../strings.ts'
import { color, font, fontSize, radius, space } from '../styles/tokens.ts'
import { Button } from './Button.tsx'
import { SignalBars } from './SignalBars.tsx'

export interface StatsPanelProps {
  store: StatsStore
  /** Whose a received track is, by trackKey; null for someone no longer in the room */
  describe: (key: string) => { name: string; kind: TrackKind } | null
  /** The export was downloaded (the page says so) */
  onExported?: () => void
  /** The advanced noise suppression (e6-t02): where it stands, and its load while on */
  noise?: { status: NoiseStatus; load: NoiseLoadStore } | null
}

const noSubscribe = () => () => {}
const noLoad = () => null

/**
 * 更多 › 連線統計 (e2-t14, AC-2.7): our own connection (round trip, loss, bitrates, the path and
 * whether it goes through TURN, the adaptation's state), what we send (codec, layers, what holds
 * the encoder back) and every subscription (whose, layer, resolution, frame rate, bitrate, loss,
 * jitter, freezes), updated with every sample (STATS_POLL_MS). 「匯出 JSON」 downloads the latest
 * sample for debugging: names, no tokens, passwords or SDP (none of them are in a sample).
 * Loaded lazily: the room's first JS does not carry it. The page puts it in the desktop side
 * panel or the phone drawer.
 */
export default function StatsPanel({ store, describe, onExported, noise }: StatsPanelProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.get)
  const noiseLoad = useSyncExternalStore(
    noise?.load.subscribe ?? noSubscribe,
    noise?.load.get ?? noLoad,
  )
  const text = strings.stats
  if (!snapshot) {
    return (
      <Body>
        <Muted role="status">{text.collecting}</Muted>
      </Body>
    )
  }
  const { sample } = snapshot
  const onExport = () => {
    if (exportJson(snapshot, describe)) onExported?.()
  }
  return (
    <Body>
      <Section aria-labelledby="stats-yours">
        <Heading id="stats-yours">
          {text.yours}
          {snapshot.signal && (
            <Level>
              <SignalBars level={snapshot.signal} />
              {text.signal[snapshot.signal]}
            </Level>
          )}
        </Heading>
        <Rows>
          <Row label={text.rtt}>{ms(sample.rttMs)}</Row>
          <Row label={text.receive}>{bitrate(sample.receiveBps)}</Row>
          <Row label={text.send}>{bitrate(sample.sendBps)}</Row>
          <Row label={text.lossDown}>{percent(inboundLoss(sample))}</Row>
          <Row label={text.lossUp}>{percent(outboundLoss(sample))}</Row>
          <Row label={text.path}>{sample.usingRelay ? text.relay : text.direct}</Row>
          <Row label={text.candidate}>
            {[sample.candidateType, sample.protocol?.toUpperCase()].filter(Boolean).join(' · ') ||
              DASH}
          </Row>
          {sample.availableOutgoingBitrate !== null && (
            <Row label={text.uplinkEstimate}>{bitrate(sample.availableOutgoingBitrate)}</Row>
          )}
        </Rows>
      </Section>

      <Section aria-labelledby="stats-adaptation">
        <Heading id="stats-adaptation">{text.adaptation}</Heading>
        <Rows>
          {snapshot.audioOnly ? (
            <Row label={text.downlink}>{text.audioOnlyOn}</Row>
          ) : (
            <Row label={text.downlink}>
              {[
                text.downlinkStages[snapshot.downlink.stage],
                snapshot.paused.length > 0 && text.paused(snapshot.paused.length),
              ]
                .filter(Boolean)
                .join(' · ')}
            </Row>
          )}
          <Row label={text.budget}>{bitrate(snapshot.downlink.budgetBps)}</Row>
          <Row label={text.uplink}>
            {snapshot.uplink.cam === 'high' && snapshot.uplink.screen === 'high'
              ? text.uplinkNormal
              : text.uplinkLimited}
          </Row>
        </Rows>
      </Section>

      <Section aria-labelledby="stats-modes">
        <Heading id="stats-modes">{text.modes}</Heading>
        <Rows>
          <Row label={text.hd}>
            {
              text.hdStates[
                snapshot.powerSaving
                  ? 'powerSaving'
                  : !snapshot.hd
                    ? 'off'
                    : snapshot.hdLimited
                      ? 'limited'
                      : 'on'
              ]
            }
          </Row>
          <Row label={text.powerSaving}>{snapshot.powerSaving ? text.on : text.off}</Row>
          <Row label={text.audioOnly}>{snapshot.audioOnly ? text.on : text.off}</Row>
          {noise && (
            <Row label={text.noise}>
              {noise.status === 'on' && noiseLoad
                ? text.noiseLoad(percent(noiseLoad.load), ms(noiseLoad.latencyMs))
                : text.noiseStates[noise.status]}
            </Row>
          )}
        </Rows>
      </Section>

      <Section aria-labelledby="stats-sending">
        <Heading id="stats-sending">{text.sending}</Heading>
        {sample.outbound.length === 0 && <Muted>{text.nothingSent}</Muted>}
        {sample.outbound.map((track) => (
          <Track key={track.trackName} aria-label={text.kinds[track.kind]}>
            <TrackName>{text.kinds[track.kind]}</TrackName>
            <Rows>
              <Row label={text.codec}>{track.codec ?? DASH}</Row>
              <Row label={text.bitrate}>{bitrate(track.bps)}</Row>
              <Row label={text.loss}>{percent(track.lossRate)}</Row>
              {track.layers.some((l) => l.rid) && (
                <Row label={text.layers}>
                  <LayerList>
                    {track.layers.map((layer) => (
                      <li key={layer.rid ?? '-'}>{layerLine(layer)}</li>
                    ))}
                  </LayerList>
                </Row>
              )}
              {track.layers.length === 1 && !track.layers[0].rid && track.layers[0].width && (
                <Row label={text.resolution}>{resolution(track.layers[0])}</Row>
              )}
              {track.qualityLimitationReason && (
                <Row label={text.limitation}>{limitation(track.qualityLimitationReason)}</Row>
              )}
            </Rows>
          </Track>
        ))}
      </Section>

      <Section aria-labelledby="stats-receiving">
        <Heading id="stats-receiving">{text.receiving}</Heading>
        {sample.inbound.length === 0 && <Muted>{text.nothingReceived}</Muted>}
        {sample.inbound.map((track) => {
          const key = `${track.sessionId}/${track.trackName}`
          return (
            <Track key={key} aria-label={trackTitle(track, describe(key))}>
              <TrackName>{trackTitle(track, describe(key))}</TrackName>
              <Rows>
                {track.media === 'video' && (
                  <>
                    <Row label={text.layer}>{layerName(snapshot.layers[key])}</Row>
                    <Row label={text.resolution}>{resolution(track)}</Row>
                    <Row label={text.fps}>{fps(track.fps)}</Row>
                  </>
                )}
                <Row label={text.codec}>{track.codec ?? DASH}</Row>
                <Row label={text.bitrate}>{bitrate(track.bps)}</Row>
                <Row label={text.loss}>{percent(track.lossRate)}</Row>
                <Row label={text.jitter}>{ms(track.jitterMs)}</Row>
                {track.media === 'video' && track.freezes > 0 && (
                  <Row label={text.freezes}>{`${track.freezes} · ${ms(track.freezeMs)}`}</Row>
                )}
              </Rows>
            </Track>
          )
        })}
      </Section>

      <Footer>
        <Button variant="secondary" onClick={onExport}>
          {text.export}
        </Button>
        <Muted>{text.exportHint}</Muted>
      </Footer>
    </Body>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  )
}

const DASH = '—'

const ms = (value: number | null) => (value === null ? DASH : `${Math.round(value)} ms`)

const percent = (value: number | null) =>
  value === null ? DASH : `${(value * 100).toFixed(value > 0 && value < 0.1 ? 1 : 0)}%`

function bitrate(bps: number | null): string {
  if (bps === null) return DASH
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`
  return `${Math.round(bps / 1000)} kbps`
}

const fps = (value: number | null) => (value === null ? DASH : `${Math.round(value)} fps`)

const resolution = (track: { width: number | null; height: number | null }) =>
  track.width && track.height ? `${track.width}×${track.height}` : DASH

const layerName = (layer: Layer | undefined) => (layer ? strings.stats.layerNames[layer] : DASH)

function layerLine(layer: OutboundSample['layers'][number]): string {
  const name = layer.rid ?? DASH
  if (!layer.active) return `${name} · ${strings.stats.layerOff}`
  return [name, resolution(layer), fps(layer.fps), bitrate(layer.bps)].join(' · ')
}

function limitation(reason: string): string {
  const names = strings.stats.limitations
  return reason in names ? names[reason as keyof typeof names] : reason
}

function trackTitle(track: InboundSample, owner: { name: string; kind: TrackKind } | null): string {
  const text = strings.stats
  const kind = owner
    ? text.kinds[owner.kind]
    : track.media === 'video'
      ? text.kinds.cam
      : text.kinds.mic
  return text.track(owner?.name ?? text.unknownMember, kind)
}

/** Loss over everything received in the interval, weighted by packets */
function inboundLoss(sample: StatsSample): number | null {
  const lost = sample.inbound.reduce((sum, t) => sum + t.lost, 0)
  const all = sample.inbound.reduce((sum, t) => sum + t.packets, 0) + lost
  return all > 0 ? lost / all : null
}

/** The worst loss the SFU reports for what we send */
function outboundLoss(sample: StatsSample): number | null {
  const rates = sample.outbound.map((t) => t.lossRate).filter((r): r is number => r !== null)
  return rates.length > 0 ? Math.max(...rates) : null
}

/** Downloads the snapshot as JSON; false where the browser cannot (no object URLs) */
function exportJson(snapshot: StatsSnapshot, describe: StatsPanelProps['describe']): boolean {
  if (typeof URL.createObjectURL !== 'function') return false
  const keys = [
    ...snapshot.sample.inbound.map((t) => `${t.sessionId}/${t.trackName}`),
    ...snapshot.paused,
  ]
  const members = Object.fromEntries(keys.map((key) => [key, describe(key)]))
  const body = {
    app: 'LongTalk',
    kind: 'connection-stats',
    exportedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    ...snapshot,
    members,
  }
  const blob = new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `longtalk-stats-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return true
}

const Body = styled.div`
  display: grid;
  align-content: start;
  gap: ${space(4)};
  min-height: 0;
  overflow: auto;
  padding: ${space(3)} ${space(4)} ${space(4)};
  font-size: ${fontSize.small};
`

const Section = styled.section`
  display: grid;
  gap: ${space(2)};
`

const Heading = styled.h3`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${space(2)};
  margin: 0;
  font-size: ${fontSize.small};
  font-weight: 700;
`

const Level = styled.span`
  display: inline-flex;
  align-items: center;
  gap: ${space(1.5)};
  color: ${color.muted};
  font-weight: 600;
`

const Rows = styled.dl`
  display: grid;
  grid-template-columns: auto 1fr;
  gap: ${space(1)} ${space(3)};
  margin: 0;

  dt {
    color: ${color.muted};
  }
  dd {
    margin: 0;
    font-family: ${font.mono};
    font-size: ${fontSize.nameplate};
    text-align: right;
    overflow-wrap: anywhere;
  }
`

const Track = styled.article`
  display: grid;
  gap: ${space(1.5)};
  padding: ${space(2)} ${space(3)};
  border: 1px solid ${color.line};
  border-radius: ${radius.button};
  background: ${color.surface2};
`

const TrackName = styled.p`
  margin: 0;
  font-weight: 700;
`

const LayerList = styled.ul`
  display: grid;
  gap: ${space(0.5)};
  margin: 0;
  padding: 0;
  list-style: none;
`

const Muted = styled.p`
  margin: 0;
  color: ${color.muted};
  line-height: 1.6;
`

const Footer = styled.div`
  display: grid;
  gap: ${space(2)};
  justify-items: start;
`
