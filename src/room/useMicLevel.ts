import { useEffect, useState } from 'react'
import { createLevelMeter, type AudioContextLike } from '../media/levelMeter.ts'

/** How often the meter re-reads the level (10 times a second is smooth enough for a bar) */
export const MIC_LEVEL_INTERVAL_MS = 100

/** The stream's microphone level, 0–1, updated every MIC_LEVEL_INTERVAL_MS; 0 without audio */
export function useMicLevel(
  stream: MediaStream | null,
  createContext?: () => AudioContextLike | null,
): number {
  // The level belongs to the stream it was read from: a new stream starts at 0
  const [reading, setReading] = useState<{ stream: MediaStream | null; level: number }>({
    stream: null,
    level: 0,
  })
  useEffect(() => {
    const meter = stream ? createLevelMeter(stream, createContext) : null
    if (!meter) return
    const timer = setInterval(
      () => setReading({ stream, level: meter.read() }),
      MIC_LEVEL_INTERVAL_MS,
    )
    return () => {
      clearInterval(timer)
      meter.close()
    }
  }, [stream, createContext])
  return reading.stream === stream && stream !== null ? reading.level : 0
}
