import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import styled from 'styled-components'
import type { ChatFile } from '../../shared/files.ts'
import { strings } from '../strings.ts'
import { color, fontSize, layer, radius, space } from '../styles/tokens.ts'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  DownloadIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from './icons.tsx'

export interface LightboxProps {
  /** Every image that can be opened, in the order of the chat */
  images: readonly ChatFile[]
  /** The one to show first */
  start: ChatFile
  load(file: ChatFile, thumb: boolean): Promise<Blob>
  download(file: ChatFile): Promise<void>
  onClose(): void
}

/**
 * The image viewer (I5, e5-t06), a lazy chunk: the whole picture, fitted to the screen, on a dark
 * backdrop. Keys: ← → for the previous and next image, + or − to zoom, Esc to close; Tab stays
 * inside, and focus goes back to the thumbnail. On a phone it fills the screen, clears the notch
 * and the home indicator, and pinching works. Zoomed in, the picture scrolls.
 */
export default function Lightbox({ images, start, load, download, onClose }: LightboxProps) {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      images.findIndex((image) => image.id === start.id),
    ),
  )
  const [zoomed, setZoomed] = useState(false)
  const file = images[index] ?? start

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    closeButton.current?.focus()
    return () => {
      if (before?.isConnected) before.focus?.()
    }
  }, [])

  const step = (by: number) => {
    if (images.length < 2) return
    setZoomed(false)
    setIndex((current) => (current + by + images.length) % images.length)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    switch (event.key) {
      case 'Escape':
        onClose()
        break
      case 'ArrowLeft':
        step(-1)
        break
      case 'ArrowRight':
        step(1)
        break
      case '+':
      case '=':
        setZoomed(true)
        break
      case '-':
        setZoomed(false)
        break
      case 'Tab': {
        const items = panel.current
          ? [...panel.current.querySelectorAll<HTMLElement>('button:not(:disabled)')]
          : []
        if (items.length === 0) return
        const first = items[0]
        const last = items[items.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
        // Keeps Tab from leaving, and away from the room's shortcuts
        event.stopPropagation()
        return
      }
      default:
        return
    }
    event.preventDefault()
    event.stopPropagation()
  }

  return createPortal(
    <Backdrop
      ref={panel}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
    >
      <Top>
        <Title id={titleId}>
          {file.name}
          {images.length > 1 && <Count>{strings.chat.file.position(index + 1, images.length)}</Count>}
        </Title>
        <Control
          type="button"
          onClick={() => setZoomed((zoom) => !zoom)}
          aria-label={zoomed ? strings.chat.file.zoomOut : strings.chat.file.zoomIn}
          title={zoomed ? strings.chat.file.zoomOut : strings.chat.file.zoomIn}
        >
          {zoomed ? <ZoomOutIcon /> : <ZoomInIcon />}
        </Control>
        <Control
          type="button"
          onClick={() => void download(file).catch(() => {})}
          aria-label={strings.chat.file.download(file.name)}
          title={strings.chat.file.download(file.name)}
        >
          <DownloadIcon />
        </Control>
        <Control
          ref={closeButton}
          type="button"
          onClick={onClose}
          aria-label={strings.common.close}
          title={strings.common.close}
        >
          <CloseIcon />
        </Control>
      </Top>
      <Stage
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
      >
        <FullImage key={file.id} file={file} load={load} zoomed={zoomed} />
        {images.length > 1 && (
          <>
            <Side
              type="button"
              $at="left"
              onClick={() => step(-1)}
              aria-label={strings.chat.file.previous}
              title={strings.chat.file.previous}
            >
              <ChevronLeftIcon />
            </Side>
            <Side
              type="button"
              $at="right"
              onClick={() => step(1)}
              aria-label={strings.chat.file.next}
              title={strings.chat.file.next}
            >
              <ChevronRightIcon />
            </Side>
          </>
        )}
      </Stage>
    </Backdrop>,
    document.body,
  )
}

/** The picture itself, fetched when it is shown: one per image, so nothing carries over */
function FullImage({
  file,
  load,
  zoomed,
}: {
  file: ChatFile
  load: LightboxProps['load']
  zoomed: boolean
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    let made: string | null = null
    load(file, false)
      .then((blob) => {
        if (cancelled) return
        made = URL.createObjectURL(blob)
        setUrl(made)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
      if (made) URL.revokeObjectURL(made)
    }
  }, [file, load])
  if (failed) return <Note role="alert">{strings.chat.file.loadFailed}</Note>
  if (!url) return <Note role="status">{strings.chat.file.loading}</Note>
  return <Picture src={url} alt={file.name} $zoomed={zoomed} />
}

const Backdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: ${layer.lightbox};
  display: flex;
  flex-direction: column;
  padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom)
    env(safe-area-inset-left);
  background: ${color.bg};
  color: ${color.fg};
`

const Top = styled.div`
  display: flex;
  align-items: center;
  flex: none;
  gap: ${space(1)};
  padding: ${space(2)} ${space(3)};
  border-bottom: 1px solid ${color.line};
`

const Title = styled.h2`
  flex: 1;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  font-size: ${fontSize.small};
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const Count = styled.span`
  margin-left: ${space(2)};
  color: ${color.muted};
  font-weight: 400;
`

const Control = styled.button`
  display: inline-grid;
  place-items: center;
  flex: none;
  width: 44px;
  height: 44px;
  padding: 0;
  border: none;
  border-radius: ${radius.button};
  background: transparent;
  color: ${color.fg};
  cursor: pointer;

  svg {
    width: 22px;
    height: 22px;
  }
  &:hover {
    background: ${color.surface2};
  }
`

const Stage = styled.div`
  position: relative;
  flex: 1;
  min-height: 0;
  display: grid;
  place-items: center;
  overflow: auto;
  overscroll-behavior: contain;
  /* Pinching keeps working on the picture; the page behind does not scroll */
  touch-action: pan-x pan-y pinch-zoom;
`

const Picture = styled.img<{ $zoomed: boolean }>`
  display: block;
  ${({ $zoomed }) =>
    $zoomed
      ? 'max-width: none; max-height: none; cursor: zoom-out;'
      : 'max-width: 100%; max-height: 100%; object-fit: contain;'}
`

const Note = styled.p`
  margin: 0;
  color: ${color.muted};
  font-size: ${fontSize.small};
`

const Side = styled.button<{ $at: 'left' | 'right' }>`
  position: fixed;
  top: 50%;
  ${({ $at }) => ($at === 'left' ? 'left' : 'right')}: max(${space(2)}, env(safe-area-inset-${({
    $at,
  }) => $at}));
  transform: translateY(-50%);
  display: inline-grid;
  place-items: center;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 1px solid ${color.line};
  border-radius: ${radius.pill};
  background: ${color.surface};
  color: ${color.fg};
  cursor: pointer;

  svg {
    width: 22px;
    height: 22px;
  }
`
