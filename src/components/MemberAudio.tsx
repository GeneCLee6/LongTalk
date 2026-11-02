import { useEffect } from 'react'
import { setSpeaker } from '../media/devices.ts'
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
}

/**
 * Plays one member's microphone (e2-t04), or the sound of their screen share (e3-t04). Kept
 * apart from their tile and the share tile (e4-t07): the room renders them outside the stage, so
 * a tile moving to another page, into the speaker's place or out of view, or the layout switching
 * to and from the share, never interrupts the sound. Each is its own element; the speaker's
 * output mixes them.
 */
export function MemberAudio({ name, track, speaker, source = 'mic' }: MemberAudioProps) {
  const ref = useTrack<HTMLAudioElement>(track)
  useEffect(() => {
    setSpeaker(ref.current, speaker)
  }, [ref, track, speaker])
  if (!track) return null
  return source === 'share' ? (
    <audio ref={ref} autoPlay data-share-audio={name} />
  ) : (
    <audio ref={ref} autoPlay data-member={name} />
  )
}
