// The microphone level for the pre-join meter (e4-t03), from a Web Audio analyser. Local only;
// the in-room speaking outline (e4-t05) can reuse it.

/** Quietest level the meter shows; anything below reads as 0 */
const FLOOR_DB = -60

/** 0–1 from a block of samples (−1…1): RMS in dB, mapped linearly from FLOOR_DB to 0 dB */
export function levelFromSamples(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (const sample of samples) sum += sample * sample
  const rms = Math.sqrt(sum / samples.length)
  if (rms === 0) return 0
  const db = 20 * Math.log10(rms)
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB))
}

/** The bits of AudioContext the meter uses, so tests can pass a fake */
export interface AudioContextLike {
  createMediaStreamSource(stream: MediaStream): {
    connect(node: unknown): unknown
    disconnect(): void
  }
  createAnalyser(): {
    fftSize: number
    getFloatTimeDomainData(array: Float32Array<ArrayBuffer>): void
  }
  close(): Promise<void>
}

export interface LevelMeter {
  /** The level right now, 0–1 */
  read(): number
  close(): void
}

const browserContext = (): AudioContextLike | null =>
  typeof AudioContext === 'undefined' ? null : new AudioContext()

/** A meter on the stream's audio, or null when it has none or there is no Web Audio */
export function createLevelMeter(
  stream: MediaStream,
  createContext: () => AudioContextLike | null = browserContext,
): LevelMeter | null {
  if (stream.getAudioTracks().length === 0) return null
  const context = createContext()
  if (!context) return null
  const source = context.createMediaStreamSource(stream)
  const analyser = context.createAnalyser()
  analyser.fftSize = 1024
  source.connect(analyser)
  const samples = new Float32Array(analyser.fftSize)
  return {
    read() {
      analyser.getFloatTimeDomainData(samples)
      return levelFromSamples(samples)
    },
    close() {
      source.disconnect()
      void context.close().catch(() => {})
    },
  }
}
