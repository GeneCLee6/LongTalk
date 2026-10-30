import { useEffect, useRef } from 'react'
import styled from 'styled-components'

export interface VideoPreviewProps {
  stream: MediaStream | null
  /** Accessible name of the video */
  label: string
  /** Mirror horizontally, as people expect to see themselves (AC-4.2) */
  mirrored?: boolean
}

/** A muted, inline <video> showing a local stream; never plays its audio back */
export function VideoPreview({ stream, label, mirrored = true }: VideoPreviewProps) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = ref.current
    if (!video) return
    video.srcObject = stream
    return () => {
      video.srcObject = null
    }
  }, [stream])
  return <Video ref={ref} aria-label={label} autoPlay muted playsInline $mirrored={mirrored} />
}

const Video = styled.video<{ $mirrored: boolean }>`
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: ${({ $mirrored }) => ($mirrored ? 'scaleX(-1)' : 'none')};
`
