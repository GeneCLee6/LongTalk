import { useEffect, useRef } from 'react'
import { setSpeaker } from '../media/devices.ts'
import {
  VOLUME_DEFAULT,
  volumeBooster,
  volumeRouting,
  type BoostRoute,
} from '../media/memberVolume.ts'
import { useTrack } from './useTrack.ts'

export interface MemberAudioProps {
  /**
   * Whose sound: kept on the element for tests and debugging (data-member for a microphone,
   * data-share-audio for the sound of their screen share)
   */
  name: string
  /** Their microphone, or their share's sound (D2), received; null plays nothing */
  track: MediaStreamTrack | null
  /** What is played: a microphone (the default), or the sound of a screen share (e3-t04) */
  source?: 'mic' | 'share'
  /** The speaker chosen in the room (setSinkId where supported); null: the system default */
  speaker: string | null
  /** How loud on this computer, percent (e6-t08, media/memberVolume.ts); 100 unless changed */
  volume?: number
}

/**
 * Plays one member's microphone (e2-t04), or the sound of their screen share (e3-t04). Kept
 * apart from their tile and the share tile (e4-t07): the room renders them outside the stage, so
 * a tile moving to another page, into the speaker's place or out of view, or the layout switching
 * to and from the share, never interrupts the sound. Each is its own element; the speaker's
 * output mixes them. The volume (e6-t08) goes on the same element, so a layout change does not
 * touch it either.
 */
export function MemberAudio({
  name,
  track,
  speaker,
  source = 'mic',
  volume = VOLUME_DEFAULT,
}: MemberAudioProps) {
  const ref = useTrack<HTMLAudioElement>(track)
  useEffect(() => {
    setSpeaker(ref.current, speaker)
  }, [ref, track, speaker])

  const { element: elementVolume, gain } = volumeRouting(volume)
  useEffect(() => {
    if (ref.current) ref.current.volume = elementVolume
  }, [ref, track, elementVolume])

  // Above 100%: the element plays the track through a gain. Only crossing 100% touches what it
  // plays; moving the slider above it only changes the gain.
  const boosted = gain !== null && track !== null
  const route = useRef<BoostRoute | null>(null)
  const latestGain = useRef(gain ?? 1)
  useEffect(() => {
    latestGain.current = gain ?? 1
    route.current?.setGain(latestGain.current)
  }, [gain])
  useEffect(() => {
    const element = ref.current
    if (!boosted || !track || !element || typeof MediaStream === 'undefined') return
    let stream: MediaStream | null = null
    const undo = volumeBooster().route(track, latestGain.current, (made) => {
      route.current = made
      stream = made.stream
      made.setGain(latestGain.current)
      element.srcObject = made.stream
      void element.play()?.catch(() => undefined)
    })
    return () => {
      route.current = null
      undo()
      // Back to the track itself, unless the element is going or has a new track already
      if (stream && element.srcObject === stream) {
        element.srcObject = new MediaStream([track])
        void element.play()?.catch(() => undefined)
      }
    }
  }, [ref, boosted, track])

  if (!track) return null
  return source === 'share' ? (
    <audio ref={ref} autoPlay data-share-audio={name} />
  ) : (
    <audio ref={ref} autoPlay data-member={name} />
  )
}
