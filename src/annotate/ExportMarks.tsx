import { useId, useState, type KeyboardEvent, type SyntheticEvent } from 'react'
import type { Rect, Size } from '../../shared/shareGeometry.ts'
import { Button } from '../components/Button.tsx'
import type { AnnotationStore } from '../room/annotationStore.ts'
import { strings } from '../strings.ts'
import { exportFileName } from './exportFile.ts'
import {
  boardPdf,
  boardViewPng,
  boardWholePng,
  drawShareFrame,
  saveFile,
  sharePdf,
  sharePng,
} from './exportRender.ts'
import { Backdrop, Choices, Panel } from './TilePanel.tsx'

/** What is being exported: the board with its view on screen, or a share with its video */
export type ExportSource =
  | { kind: 'board'; view: { box: Size; rect: Rect; pixelRatio: number } | null }
  | { kind: 'share'; video: () => HTMLVideoElement | null; picture: boolean }

export interface ExportMarksProps {
  store: AnnotationStore
  layer: string
  roomName: string | null
  source: ExportSource
  onClose: () => void
}

/**
 * Exporting the whiteboard or a share with its marks (J4, e7-t07; AC-7.5). Everything is made in
 * this browser from what it already has, so anyone in the meeting may: it is what a screenshot would
 * give them. Laser pointers and name tags are not in it. Inside the tile, so it works in fullscreen.
 */
export default function ExportMarks({ store, layer, roomName, source, onClose }: ExportMarksProps) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const titleId = useId()
  const text = strings.annotation.exporting

  const run = async (make: () => Promise<{ blob: Blob; extension: 'png' | 'pdf' }>) => {
    setBusy(true)
    setFailed(false)
    try {
      const { blob, extension } = await make()
      const what = source.kind === 'board' ? text.boardFile : text.shareFile
      saveFile(blob, exportFileName(roomName, what, new Date(), extension))
      onClose()
    } catch (error) {
      console.error('export failed', error)
      setBusy(false)
      setFailed(true)
    }
  }

  const stop = (event: SyntheticEvent) => event.stopPropagation()
  const onKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation()
    if (event.key === 'Escape') onClose()
  }
  const title = () => `LongTalk ${roomName ?? ''}`.trim()
  const strokes = () => store.strokes(layer)

  const shareFrame = () => {
    const video = source.kind === 'share' ? source.video() : null
    if (source.kind !== 'share' || !video) throw new Error('no picture to export')
    return drawShareFrame(video, strokes(), source.picture)
  }

  return (
    <div onPointerDown={stop} onDoubleClick={stop} onKeyDown={onKeyDown}>
      <Backdrop onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
        <Panel role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy}>
          <h2 id={titleId}>{source.kind === 'board' ? text.boardTitle : text.shareTitle}</h2>
          <p role="status">{busy ? text.working : failed ? text.failed : text.hint}</p>
          {source.kind === 'board' ? (
            <Choices>
              {source.view && (
                <Button
                  autoFocus
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    const { box, rect, pixelRatio } = source.view!
                    void run(async () => ({
                      blob: await boardViewPng(strokes(), box, rect, pixelRatio),
                      extension: 'png',
                    }))
                  }}
                >
                  {text.viewPng}
                </Button>
              )}
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => ({ blob: await boardWholePng(strokes()), extension: 'png' }))
                }
              >
                {text.wholePng}
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => ({
                    blob: await boardPdf(strokes(), title()),
                    extension: 'pdf',
                  }))
                }
              >
                {text.wholePdf}
              </Button>
              <Button variant="ghost" onClick={onClose}>
                {strings.common.cancel}
              </Button>
            </Choices>
          ) : (
            <Choices>
              <Button
                autoFocus
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => ({ blob: await sharePng(shareFrame()), extension: 'png' }))
                }
              >
                {text.framePng}
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => ({
                    blob: await sharePdf(shareFrame(), title()),
                    extension: 'pdf',
                  }))
                }
              >
                {text.framePdf}
              </Button>
              <Button variant="ghost" onClick={onClose}>
                {strings.common.cancel}
              </Button>
            </Choices>
          )}
        </Panel>
      </Backdrop>
    </div>
  )
}
