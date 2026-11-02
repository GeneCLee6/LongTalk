import { useEffect, useState } from 'react'
import { speakingMonitor, type SpeakingMonitor } from '../media/speaking.ts'

/**
 * Whether the microphone `track` is speaking now (e4-t05): our own local track or a received
 * one; false without a track (muted, not received yet)
 */
export function useSpeaking(
  track: MediaStreamTrack | null,
  monitor: SpeakingMonitor = speakingMonitor(),
): boolean {
  // The reading belongs to the track it came from: a new track starts quiet
  const [reading, setReading] = useState<{ track: MediaStreamTrack | null; speaking: boolean }>({
    track: null,
    speaking: false,
  })
  useEffect(() => {
    if (!track) return
    return monitor.watch(track, (speaking) => setReading({ track, speaking }))
  }, [track, monitor])
  return track !== null && reading.track === track && reading.speaking
}
