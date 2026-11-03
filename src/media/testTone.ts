// The pre-join speaker test (G1, e4-t09): a short chime played through the speaker chosen in the
// menu. It is a WAV made here (no file to download, nothing in the JS budget beyond this code)
// and played by an <audio> element, because HTMLMediaElement.setSinkId is what picks the output
// (canChooseSpeaker in capabilities.ts); where the browser cannot choose, the button is hidden.

/** Three rising notes (C6, E6, G6), each fading out; seconds from the start */
const NOTES = [
  { freq: 1046.5, at: 0, length: 0.35 },
  { freq: 1318.51, at: 0.28, length: 0.35 },
  { freq: 1567.98, at: 0.56, length: 0.6 },
] as const

/** How loud, out of 1: clearly audible, not startling */
const VOLUME = 0.35

export const TONE_SECONDS = 1.2

/** A 16-bit mono PCM WAV of the chime */
export function toneWav(sampleRate = 22_050): Uint8Array {
  const samples = Math.round(TONE_SECONDS * sampleRate)
  const bytes = new Uint8Array(44 + samples * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // bytes per second
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  view.setUint32(40, samples * 2, true)
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate
    let value = 0
    for (const note of NOTES) {
      const local = t - note.at
      if (local < 0 || local > note.length) continue
      // A 5 ms attack, then an exponential fade
      const envelope = Math.min(1, local / 0.005) * Math.exp((-4 * local) / note.length)
      value += Math.sin(2 * Math.PI * note.freq * local) * envelope
    }
    const clipped = Math.max(-1, Math.min(1, value * VOLUME))
    view.setInt16(44 + i * 2, Math.round(clipped * 32_767), true)
  }
  return bytes
}

/** The part of HTMLAudioElement the test uses, so tests can pass a fake */
export interface ToneElement {
  src: string
  onended: (() => void) | null
  play(): Promise<void> | void
  pause(): void
  setSinkId?: (deviceId: string) => Promise<void>
}

export interface ToneDeps {
  createElement?: () => ToneElement
  createUrl?: (bytes: Uint8Array) => string
  revokeUrl?: (url: string) => void
}

export interface TonePlayback {
  /** Settles when the chime ends, is stopped, or could not play */
  done: Promise<void>
  stop(): void
}

const browserUrl = (bytes: Uint8Array) =>
  URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'audio/wav' }))

/**
 * Plays the chime once through `speakerId` (null: the system's default). A speaker that is gone
 * leaves it on the current output, like setSpeaker in devices.ts.
 */
export function playTestTone(speakerId: string | null, deps: ToneDeps = {}): TonePlayback {
  let element: ToneElement
  let url: string
  try {
    element = deps.createElement?.() ?? (new Audio() as unknown as ToneElement)
    url = (deps.createUrl ?? browserUrl)(toneWav())
  } catch {
    // No Audio or no blob URLs: nothing to play
    return { done: Promise.resolve(), stop: () => {} }
  }
  const revoke =
    deps.revokeUrl ??
    ((done: string) => {
      try {
        URL.revokeObjectURL(done)
      } catch {
        // Nothing to free
      }
    })
  let finish: () => void = () => {}
  let finished = false
  const done = new Promise<void>((resolve) => {
    finish = () => {
      if (finished) return
      finished = true
      element.onended = null
      element.pause()
      revoke(url)
      resolve()
    }
  })
  element.onended = finish
  element.src = url
  void (async () => {
    try {
      if (speakerId !== null && element.setSinkId) {
        await element.setSinkId(speakerId).catch(() => undefined)
      }
      if (finished) return
      await element.play()
    } catch {
      finish()
    }
  })()
  return { done, stop: finish }
}
