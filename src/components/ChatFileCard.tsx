import { useEffect, useRef, useState } from 'react'
import styled from 'styled-components'
import type { ChatFile } from '../../shared/files.ts'
import { formatBytes } from '../room/chatText.ts'
import { fileTypeLabel } from '../room/fileText.ts'
import { strings } from '../strings.ts'
import { color, fontSize, radius, space } from '../styles/tokens.ts'
import { DownloadIcon, FileIcon } from './icons.tsx'

export interface ChatFileCardProps {
  file: ChatFile
  load(file: ChatFile, thumb: boolean): Promise<Blob>
  download(file: ChatFile): Promise<void>
  /** Opens the image viewer; only for images */
  onView(file: ChatFile): void
  /** The time to judge its expiry by, when it is not now (tests) */
  now?: number
}

/**
 * A shared file in the chat (I5, e5-t05): its name, size and type, and a download button. An image
 * also shows its thumbnail, and pressing it opens the viewer (e5-t06). Past its 24 hours it only
 * says so. The thumbnail is fetched when it comes into view, so a long history costs nothing.
 */
export function ChatFileCard({ file, load, download, onView, now }: ChatFileCardProps) {
  const [gone, setGone] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [problem, setProblem] = useState(false)
  // Judged when the card appears; a card left open learns it from the 410 when it is pressed
  const [seenAt] = useState(() => now ?? Date.now())
  const expired = gone || seenAt >= file.expiresAt
  const save = () => {
    setDownloading(true)
    setProblem(false)
    download(file)
      .catch((error: unknown) => {
        if (error instanceof Error && error.message === 'gone') setGone(true)
        else setProblem(true)
      })
      .finally(() => setDownloading(false))
  }
  const details = strings.chat.file.details(formatBytes(file.size), fileTypeLabel(file))
  if (expired) {
    return (
      <Card>
        <Row>
          <FileMark aria-hidden="true">
            <FileIcon />
          </FileMark>
          <Text>
            <Name>{file.name}</Name>
            <Details>{strings.chat.file.expired}</Details>
          </Text>
        </Row>
      </Card>
    )
  }
  return (
    <Card>
      {file.kind === 'image' && file.thumb && (
        <Thumbnail file={file} load={load} onOpen={() => onView(file)} />
      )}
      <Row>
        <FileMark aria-hidden="true">
          <FileIcon />
        </FileMark>
        <Text>
          <Name>{file.name}</Name>
          <Details>{details}</Details>
        </Text>
        {file.kind === 'image' && !file.thumb && (
          <Action type="button" onClick={() => onView(file)}>
            {strings.chat.file.viewShort}
          </Action>
        )}
        <Action
          type="button"
          onClick={save}
          disabled={downloading}
          aria-label={strings.chat.file.download(file.name)}
          title={strings.chat.file.download(file.name)}
        >
          <DownloadIcon />
        </Action>
      </Row>
      {problem && <Problem role="alert">{strings.chat.file.downloadFailed}</Problem>}
    </Card>
  )
}

function Thumbnail({
  file,
  load,
  onOpen,
}: {
  file: ChatFile
  load: ChatFileCardProps['load']
  onOpen: () => void
}) {
  const button = useRef<HTMLButtonElement>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const element = button.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true)
      },
      { rootMargin: '200px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let made: string | null = null
    load(file, true)
      .then((blob) => {
        if (cancelled) return
        made = URL.createObjectURL(blob)
        setUrl(made)
      })
      .catch(() => {})
    return () => {
      cancelled = true
      if (made) URL.revokeObjectURL(made)
    }
  }, [visible, file, load])

  return (
    <ThumbButton
      ref={button}
      type="button"
      onClick={onOpen}
      aria-label={strings.chat.file.view(file.name)}
    >
      {url && <img src={url} alt="" />}
    </ThumbButton>
  )
}

const Card = styled.div`
  display: grid;
  gap: ${space(2)};
  min-width: 0;
  white-space: normal;
`

const ThumbButton = styled.button`
  display: block;
  width: 240px;
  max-width: 100%;
  height: 160px;
  padding: 0;
  border: 1px solid ${color.line};
  border-radius: ${radius.button};
  background: ${color.surface};
  overflow: hidden;
  cursor: zoom-in;

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
`

const Row = styled.div`
  display: flex;
  align-items: center;
  gap: ${space(2)};
  min-width: 0;
`

const FileMark = styled.span`
  display: inline-grid;
  place-items: center;
  flex: none;
  color: ${color.muted};

  svg {
    width: 20px;
    height: 20px;
  }
`

const Text = styled.span`
  display: grid;
  flex: 1;
  min-width: 0;
`

const Name = styled.span`
  overflow-wrap: anywhere;
  font-weight: 600;
`

const Details = styled.span`
  color: ${color.muted};
  font-size: ${fontSize.toolbarLabel};
`

const Action = styled.button`
  display: inline-grid;
  place-items: center;
  flex: none;
  min-width: 40px;
  min-height: 40px;
  padding: 0 ${space(1)};
  border: 1px solid ${color.line};
  border-radius: ${radius.button};
  background: transparent;
  color: ${color.fg};
  font: inherit;
  font-size: ${fontSize.toolbarLabel};
  cursor: pointer;

  svg {
    width: 20px;
    height: 20px;
  }
  &:hover:not(:disabled) {
    border-color: ${color.primary};
  }
  &:disabled {
    color: ${color.muted};
    cursor: progress;
  }
`

const Problem = styled.span`
  color: ${color.warn};
  font-size: ${fontSize.toolbarLabel};
`
