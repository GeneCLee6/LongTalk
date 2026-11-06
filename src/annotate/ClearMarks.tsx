import { useId, useState, type KeyboardEvent, type SyntheticEvent } from 'react'
import { PAST_AUTHOR } from '../../shared/annotation.ts'
import { Button } from '../components/Button.tsx'
import { ConfirmDialog } from '../components/ConfirmDialog.tsx'
import { ClearIcon } from '../components/icons.tsx'
import { Control } from '../components/shareChrome.tsx'
import type { AnnotationStore } from '../room/annotationStore.ts'
import { strings } from '../strings.ts'
import { Backdrop, Choices, Panel } from './TilePanel.tsx'

export interface ClearMarksProps {
  store: AnnotationStore
  layer: string
  nameOf: (memberId: string) => string | null
}

/** All of a layer, or one member's */
type Choice = { by: string | null; name: string }

/**
 * Clearing everything on a layer, or one person's (J3, e7-t05; AC-7.3): for a host, a co-host and
 * who owns the layer. A button on the tile's controls: there is no toolbar with the policy off, and
 * that is when it is still needed. It asks what, then asks once more: nobody gets this back, and
 * unlike one's own undo it takes other people's work. Inside the tile, so it works in fullscreen.
 * The room decides (shared/roles.ts mayClearLayer) and tells who lost something.
 */
export default function ClearMarks({ store, layer: layerId, nameOf }: ClearMarksProps) {
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState<Choice | null>(null)
  const titleId = useId()
  const text = strings.annotation
  const counts = open ? store.authors(layerId) : null
  const total = counts ? [...counts.values()].reduce((sum, count) => sum + count, 0) : 0

  const close = () => {
    setOpen(false)
    setChoice(null)
  }
  // What is pressed here is not a gesture on the tile underneath
  const stop = (event: SyntheticEvent) => event.stopPropagation()
  const onKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation()
    if (event.key === 'Escape') close()
  }

  return (
    <>
      <Control
        type="button"
        aria-label={text.clearOthers}
        title={text.clearOthers}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <ClearIcon />
      </Control>
      {open && (
        <div onPointerDown={stop} onDoubleClick={stop} onKeyDown={onKeyDown}>
          {choice ? (
            <ConfirmDialog
              title={
                choice.by === null ? text.clearAllTitle : text.clearOneTitle(choice.name)
              }
              body={choice.by === null ? text.clearAllBody : text.clearOneBody(choice.name)}
              confirmLabel={text.clearConfirm}
              onCancel={close}
              onConfirm={() => {
                store.clearLayer(layerId, choice.by)
                close()
              }}
            />
          ) : (
            <Backdrop
              onPointerDown={(event) => event.target === event.currentTarget && close()}
            >
              <Panel role="dialog" aria-modal="true" aria-labelledby={titleId}>
                <h2 id={titleId}>{text.clearOthers}</h2>
                <Choices>
                  <Button
                    autoFocus
                    variant="danger"
                    onClick={() => setChoice({ by: null, name: '' })}
                  >
                    {text.clearAll(total)}
                  </Button>
                  {[...(counts ?? [])].map(([by, count]) => {
                    const name = by === PAST_AUTHOR ? text.earlier : (nameOf(by) ?? text.departed)
                    return (
                      <Button
                        key={by}
                        variant="secondary"
                        onClick={() => setChoice({ by, name })}
                      >
                        {text.clearOne(name, count)}
                      </Button>
                    )
                  })}
                  <Button variant="ghost" onClick={close}>
                    {strings.common.cancel}
                  </Button>
                </Choices>
              </Panel>
            </Backdrop>
          )}
        </div>
      )}
    </>
  )
}
