import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemberAudio } from '../../../src/components/MemberAudio.tsx'
import { startBackgroundBlur, type BackgroundBlur } from '../../../src/media/backgroundBlur.ts'
import { BLUR_ASSETS } from '../../../src/media/blurAssets.ts'
import type { BlurReport } from '../../../src/media/blurLoad.ts'

// The real pipeline and the real MemberAudio over a real PeerConnection (e2e/local/blur.spec.ts):
// `vite preview` has no Realtime SFU, so nothing is ever published in a room there. Two
// PeerConnections on this page stand in for it: the sender offers three simulcast layers as
// CloudflareRealtimeTransport does, and the SDP is edited so the other end takes them as one
// stream (the usual loopback for simulcast). What is measured is the sender's own statistics.

async function connect(a: RTCPeerConnection, b: RTCPeerConnection, simulcast: boolean) {
  a.onicecandidate = ({ candidate }) => void (candidate && b.addIceCandidate(candidate))
  b.onicecandidate = ({ candidate }) => void (candidate && a.addIceCandidate(candidate))
  const offer = await a.createOffer()
  await a.setLocalDescription(offer)
  const sdp = simulcast
    ? offer.sdp!.split('\r\n').filter((line) => !/^a=(rid:|simulcast:)/.test(line)).join('\r\n')
    : offer.sdp!
  await b.setRemoteDescription({ type: 'offer', sdp })
  const answer = await b.createAnswer()
  await b.setLocalDescription(answer)
  const rids = 'a=rid:f recv\r\na=rid:h recv\r\na=rid:q recv\r\na=simulcast:recv f;h;q\r\n'
  await a.setRemoteDescription({
    type: 'answer',
    sdp: simulcast ? `${answer.sdp!.trimEnd()}\r\n${rids}` : answer.sdp!,
  })
}

interface Layer {
  rid: string
  frames: number
  width: number
}

let blur: BackgroundBlur | null = null
let sender: RTCRtpSender | null = null
let camera: MediaStreamTrack | null = null
let renegotiations = 0
let lastReport: BlurReport | null = null

const api = {
  /** Publishes the camera in three layers, then sends the blurred track instead */
  async publishCamera() {
    // A 720p "camera" that moves: the local fake camera is one still 640 × 360 frame, too small for
    // Chrome to send three layers from (encoding.ts)
    const canvas = document.createElement('canvas')
    canvas.width = 1280
    canvas.height = 720
    const context = canvas.getContext('2d')!
    let x = 0
    setInterval(() => {
      x = (x + 16) % 1280
      context.fillStyle = 'rgb(40, 60, 90)'
      context.fillRect(0, 0, 1280, 720)
      context.fillStyle = 'rgb(220, 200, 60)'
      context.fillRect(x, 200, 200, 300)
    }, 33)
    camera = canvas.captureStream(30).getVideoTracks()[0]
    const a = new RTCPeerConnection()
    const b = new RTCPeerConnection()
    const transceiver = a.addTransceiver(camera, {
      direction: 'sendonly',
      sendEncodings: [
        { rid: 'f' },
        { rid: 'h', scaleResolutionDownBy: 2 },
        { rid: 'q', scaleResolutionDownBy: 4 },
      ],
    })
    sender = transceiver.sender
    await connect(a, b, true)
    a.onnegotiationneeded = () => {
      renegotiations += 1
    }
  },
  async blurOn() {
    blur = await startBackgroundBlur(BLUR_ASSETS)
    const running = blur
    const ready = new Promise<void>((resolve) => {
      running.subscribe((event) => {
        if (event.type === 'state' && running.ready()) resolve()
        if (event.type === 'report') lastReport = event.report
      })
    })
    running.setInput(camera)
    await ready
    await sender!.replaceTrack(running.track)
    return running.path
  },
  async blurOff() {
    await sender!.replaceTrack(camera)
    blur?.close()
    blur = null
  },
  sentTrackIsCamera: () => sender!.track === camera,
  renegotiations: () => renegotiations,
  lastReport: () => lastReport,
  async layers(): Promise<Layer[]> {
    const report = await sender!.getStats()
    const layers: Layer[] = []
    report.forEach((entry: Record<string, unknown>) => {
      if (entry.type !== 'outbound-rtp') return
      layers.push({
        rid: entry.rid as string,
        frames: (entry.framesEncoded as number) ?? 0,
        width: (entry.frameWidth as number) ?? 0,
      })
    })
    return layers.sort((x, y) => x.rid.localeCompare(y.rid))
  },
  /** A 440 Hz tone over a PeerConnection, played by a real MemberAudio */
  async startTone() {
    const context = new AudioContext()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    gain.gain.value = 0.2
    const destination = context.createMediaStreamDestination()
    oscillator.connect(gain).connect(destination)
    oscillator.start()
    const a = new RTCPeerConnection()
    const b = new RTCPeerConnection()
    a.addTrack(destination.stream.getAudioTracks()[0], destination.stream)
    const received = new Promise<MediaStreamTrack>((resolve) => {
      b.ontrack = ({ track }) => resolve(track)
    })
    await connect(a, b, false)
    showTrack(await received)
  },
  setVolume: (percent: number) => showVolume(percent),
  /** The element's own volume, and the peak of what it is playing, 0–1 */
  async playing() {
    const element = document.querySelector('audio')!
    const context = new AudioContext()
    await context.resume()
    const source = context.createMediaStreamSource(element.srcObject as MediaStream)
    const analyser = context.createAnalyser()
    analyser.fftSize = 2048
    source.connect(analyser)
    const samples = new Float32Array(analyser.fftSize)
    let peak = 0
    for (let i = 0; i < 25; i++) {
      await new Promise((resolve) => setTimeout(resolve, 40))
      analyser.getFloatTimeDomainData(samples)
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample))
    }
    source.disconnect()
    await context.close()
    return { volume: element.volume, peak, paused: element.paused }
  },
}

let showTrack: (track: MediaStreamTrack) => void = () => {}
let showVolume: (percent: number) => void = () => {}

function Sound() {
  const [track, setTrack] = useState<MediaStreamTrack | null>(null)
  const [volume, setVolume] = useState(100)
  useEffect(() => {
    showTrack = setTrack
    showVolume = setVolume
  }, [])
  return <MemberAudio name="Bob" track={track} speaker={null} volume={volume} />
}

declare global {
  interface Window {
    media: typeof api
  }
}
window.media = api
createRoot(document.getElementById('root')!).render(<Sound />)
