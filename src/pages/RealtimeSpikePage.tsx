import { useEffect, useRef, useState } from 'react'
import styled from 'styled-components'
import { Button } from '../components/Button.tsx'
import { ToastViewport } from '../components/Toast.tsx'
import { useToasts } from '../components/useToasts.ts'
import { CloudflareRealtimeTransport } from '../media/CloudflareRealtimeTransport.ts'
import {
  MediaTransportError,
  type ConnectionState,
  type MediaTransport,
  type PublishedTrack,
} from '../media/MediaTransport.ts'
import { listPublishedTracks } from '../media/spike.ts'
import { strings } from '../strings.ts'
import { color, font, fontSize, radius, space } from '../styles/tokens.ts'

// A2 spike (e2-t01): the smallest two-browser exchange through Cloudflare Realtime. Each side
// publishes mic + cam, copies its session id to the other, and pulls the other's tracks. No
// RoomDO yet; that is A3/B1. How to run it: DEPLOY.md §5.

const t = strings.spike

function errorText(error: unknown): string {
  if (error instanceof MediaTransportError) {
    if (error.code === 'sfu_not_configured') return strings.errors.sfuNotConfigured
    if (error.code === 'not_found') return strings.errors.trackNotFound
    return `${strings.errors.sfu} (${error.message})`
  }
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return strings.errors.permissionDenied
  }
  return strings.errors.unknown
}

export default function RealtimeSpikePage() {
  const transportRef = useRef<MediaTransport | null>(null)
  const localVideo = useRef<HTMLVideoElement>(null)
  const remoteVideo = useRef<HTMLVideoElement>(null)
  const [state, setState] = useState<ConnectionState>('new')
  const [busy, setBusy] = useState(false)
  const [published, setPublished] = useState<PublishedTrack[]>([])
  const [remoteSession, setRemoteSession] = useState('')
  const [stats, setStats] = useState('')
  const [sessionId, setSessionId] = useState('')
  const { toasts, show, dismiss } = useToasts()

  const transport = () => {
    if (!transportRef.current) {
      const created = new CloudflareRealtimeTransport()
      created.on('state', (next) => {
        setState(next)
        setSessionId(created.sessionId ?? '')
      })
      transportRef.current = created
    }
    return transportRef.current
  }

  useEffect(() => () => void transportRef.current?.close(), [])

  useEffect(() => {
    if (state !== 'connected') return
    const timer = setInterval(async () => {
      const s = await transportRef.current?.getStats().catch(() => null)
      if (s) setStats(t.stats(s.rttMs === null ? '–' : s.rttMs.toFixed(0), s.usingRelay))
    }, 2000)
    return () => clearInterval(timer)
  }, [state])

  const publish = async () => {
    setBusy(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
      if (localVideo.current) localVideo.current.srcObject = stream
      const tr = transport()
      await tr.connect()
      const results: PublishedTrack[] = []
      for (const track of stream.getTracks()) {
        results.push(await tr.publish(track, { kind: track.kind === 'audio' ? 'mic' : 'cam' }))
      }
      setPublished(results)
    } catch (error) {
      show(errorText(error), 'danger')
    } finally {
      setBusy(false)
    }
  }

  const pull = async () => {
    setBusy(true)
    try {
      const tr = transport()
      await tr.connect()
      const refs = await listPublishedTracks(remoteSession.trim())
      if (refs.length === 0) throw new MediaTransportError('not_found')
      const stream = new MediaStream()
      for (const ref of refs) stream.addTrack((await tr.subscribe(ref)).track)
      if (remoteVideo.current) remoteVideo.current.srcObject = stream
    } catch (error) {
      show(errorText(error), 'danger')
    } finally {
      setBusy(false)
    }
  }

  const hangUp = async () => {
    await transportRef.current?.close()
    transportRef.current = null
    for (const video of [localVideo.current, remoteVideo.current]) {
      if (video?.srcObject instanceof MediaStream)
        video.srcObject.getTracks().forEach((tr) => tr.stop())
      if (video) video.srcObject = null
    }
    setPublished([])
    setStats('')
    setSessionId('')
    setState('new')
  }

  return (
    <Main>
      <h1>{t.title}</h1>
      <p>{t.intro}</p>
      <Row>
        <Button onClick={publish} disabled={busy || published.length > 0}>
          {busy ? t.publishing : t.publish}
        </Button>
        <Button variant="danger" onClick={hangUp} disabled={state === 'new'}>
          {t.hangUp}
        </Button>
      </Row>
      <Meta>
        <span>{t.state(state)}</span>
        {stats && <span>{stats}</span>}
      </Meta>
      {sessionId && (
        <Field>
          {t.sessionId}
          <Code readOnly value={sessionId} onFocus={(e) => e.currentTarget.select()} />
        </Field>
      )}
      {published.length > 0 && (
        <Meta>{t.tracks(published.map((p) => p.trackName).join('、'))}</Meta>
      )}
      <Row>
        <Field>
          {t.remoteSession}
          <Code
            value={remoteSession}
            placeholder={t.remoteSessionPlaceholder}
            onChange={(e) => setRemoteSession(e.target.value)}
          />
        </Field>
        <Button variant="secondary" onClick={pull} disabled={busy || !remoteSession.trim()}>
          {t.pull}
        </Button>
      </Row>
      <Videos>
        <figure>
          <Video ref={localVideo} autoPlay playsInline muted $mirror />
          <figcaption>{t.localVideo}</figcaption>
        </figure>
        <figure>
          <Video ref={remoteVideo} autoPlay playsInline />
          <figcaption>{t.remoteVideo}</figcaption>
        </figure>
      </Videos>
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </Main>
  )
}

const Main = styled.main`
  max-width: 960px;
  margin: 0 auto;
  padding: ${space(6)} ${space(4)};
  font-family: ${font.ui};
  color: ${color.fg};
`

const Row = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: ${space(3)};
  margin: ${space(4)} 0;
`

const Meta = styled.p`
  display: flex;
  gap: ${space(4)};
  color: ${color.muted};
  font-size: ${fontSize.small};
`

const Field = styled.label`
  display: flex;
  flex-direction: column;
  gap: ${space(1)};
  font-size: ${fontSize.small};
  color: ${color.muted};
`

const Code = styled.input`
  min-width: min(420px, 80vw);
  padding: ${space(2)} ${space(3)};
  border: 1px solid ${color.line};
  border-radius: ${radius.button};
  background: ${color.surface2};
  color: ${color.fg};
  font-family: ${font.mono};
  font-size: ${fontSize.small};
`

const Videos = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: ${space(2)};

  figure {
    margin: 0;
  }
  figcaption {
    color: ${color.muted};
    font-size: ${fontSize.small};
  }
`

const Video = styled.video<{ $mirror?: boolean }>`
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: ${radius.tile};
  background: linear-gradient(${color.tileFrom}, ${color.tileTo});
  transform: ${({ $mirror }) => ($mirror ? 'scaleX(-1)' : 'none')};
`
