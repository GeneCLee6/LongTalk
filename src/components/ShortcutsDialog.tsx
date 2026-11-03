import { useEffect, useId, useState, type KeyboardEvent } from 'react'
import styled from 'styled-components'
import { SHORTCUTS } from '../room/shortcuts.ts'
import { strings } from '../strings.ts'
import { color, font, fontSize, layer, radius, space } from '../styles/tokens.ts'
import { Button } from './Button.tsx'

/** How a key is written in the list: Space and Escape spelt out, letters as they are */
function keyName(key: string): string {
  if (key === 'Space') return strings.shortcuts.space
  if (key === 'Escape') return 'Esc'
  return key
}

/**
 * 鍵盤快捷鍵 (G4, e4-t13, AC-4.9): every room shortcut and push-to-talk, opened with ? or from
 * 更多. A modal: Escape, the close button or a click outside closes it, and focus goes back.
 */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId()
  const hintId = useId()
  const [before] = useState(() => document.activeElement as HTMLElement | null)
  useEffect(() => () => before?.focus?.(), [before])
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
  }
  const actions = strings.shortcuts.actions
  const rows = [
    ...SHORTCUTS.slice(0, 1).map((s) => ({ key: s.key, text: actions[s.action] })),
    { key: 'Space', text: actions.pushToTalk },
    ...SHORTCUTS.slice(1).map((s) => ({ key: s.key, text: actions[s.action] })),
  ]
  return (
    <Backdrop onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <Panel
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hintId}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId}>{strings.shortcuts.title}</h2>
        <List>
          {rows.map((row) => (
            <Row key={row.key}>
              <dt>
                <kbd>{keyName(row.key)}</kbd>
              </dt>
              <dd>{row.text}</dd>
            </Row>
          ))}
        </List>
        <Hint id={hintId}>{strings.shortcuts.hint}</Hint>
        <Actions>
          <Button autoFocus variant="secondary" onClick={onClose}>
            {strings.common.close}
          </Button>
        </Actions>
      </Panel>
    </Backdrop>
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
`

const Panel = styled.div`
  display: grid;
  gap: ${space(3)};
  width: min(100%, 460px);
  max-height: calc(100dvh - ${space(8)});
  overflow: auto;
  padding: ${space(5)};
  border: 1px solid ${color.line};
  border-radius: ${radius.panel};
  background: ${color.surface};
  color: ${color.fg};
  box-shadow: 0 8px 24px ${color.shadow};

  h2 {
    margin: 0;
    font-size: 18px;
  }
`

const List = styled.dl`
  display: grid;
  gap: ${space(2)};
  margin: 0;
`

const Row = styled.div`
  display: grid;
  grid-template-columns: ${space(20)} 1fr;
  align-items: center;
  gap: ${space(3)};

  dt,
  dd {
    margin: 0;
  }
  dd {
    font-size: ${fontSize.small};
  }
  kbd {
    display: inline-block;
    min-width: ${space(7)};
    padding: ${space(0.5)} ${space(2)};
    border: 1px solid ${color.line};
    border-bottom-width: 2px;
    border-radius: ${radius.nameplate};
    background: ${color.surface2};
    font-family: ${font.mono};
    font-size: ${fontSize.small};
    text-align: center;
  }
`

const Hint = styled.p`
  margin: 0;
  color: ${color.muted};
  font-size: ${fontSize.small};
  line-height: 1.6;
`

const Actions = styled.div`
  display: flex;
  justify-content: flex-end;
`
