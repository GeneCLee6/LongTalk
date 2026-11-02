import { useEffect } from 'react'
import { setSpeaker } from '../media/devices.ts'
import { useTrack } from './useTrack.ts'

export interface MemberAudioProps {
  /** Whose microphone: kept on the element (data-member) for tests and debugging */
  name: string
  /** Their microphone, received; null plays nothing */
  track: MediaStreamTrack | null
  /** The speaker chosen in the room (setSinkId where supported); null: the system default */
  speaker: string | null
}

/**
 * Plays one member's microphone (e2-t04). Kept apart from their tile (e4-t07): the room renders
 * one per member outside the stage, so a tile moving to another page, into the speaker's place
 * or out of view never interrupts the sound.
 */
export function MemberAudio({ name, track, speaker }: MemberAudioProps) {
  const ref = useTrack<HTMLAudioElement>(track)
  useEffect(() => {
    setSpeaker(ref.current, speaker)
  }, [ref, track, speaker])
  if (!track) return null
  return <audio ref={ref} autoPlay data-member={name} />
}
