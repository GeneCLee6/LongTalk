import { useId, useState, type KeyboardEvent, type SyntheticEvent } from 'react'
import styled from 'styled-components'
import { Button } from '../components/Button.tsx'
import { ConfirmDialog } from '../components/ConfirmDialog.tsx'
import { ClearIcon } from '../components/icons.tsx'
import { Control } from '../components/shareChrome.tsx'
import type { AnnotationStore } from '../room/annotationStore.ts'
import { strings } from '../strings.ts'
import { color, fontSize, layer, radius, space } from '../styles/tokens.ts'

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
        <div onPointerDown={stop} onDoubleClick={stop} onKeyDown={onKeyDown} onWheel={stop}>
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
                    const name = nameOf(by) ?? text.departed
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

const Backdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: ${layer.menu};
  display: grid;
  place-items: center;
  padding: ${space(4)};
  background: ${color.overlay};
  cursor: default;
`

const Panel = styled.div`
  display: grid;
  gap: ${space(3)};
  width: min(100%, 360px);
  max-height: 100%;
  overflow-y: auto;
  padding: ${space(5)};
  border: 1px solid ${color.line};
  border-radius: ${radius.panel};
  background: ${color.surface};
  color: ${color.fg};
  box-shadow: 0 8px 24px ${color.shadow};

  h2 {
    margin: 0;
    font-size: ${fontSize.base};
  }
`

const Choices = styled.div`
  display: grid;
  gap: ${space(2)};
`
