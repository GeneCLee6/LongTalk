import styled, { keyframes } from 'styled-components'
import type { ChatMessage } from '../../shared/chat.ts'
import { strings } from '../strings.ts'
import { color, fontSize, layer, media, motion, radius, space } from '../styles/tokens.ts'
import { CloseIcon } from './icons.tsx'

export interface ChatPreviewProps {
  /** The newest message from someone else, while the chat is closed; null shows nothing */
  message: ChatMessage | null
  /** The bubble was pressed: open the chat */
  onOpen: () => void
  onDismiss: () => void
}

/**
 * A short preview of a new chat message while the panel is closed (e5-t02): a bubble above the
 * toolbar's right end with the sender and the start of the text; pressing it opens the chat.
 * Announced politely; the toolbar's badge keeps the count after it goes.
 */
export function ChatPreview({ message, onOpen, onDismiss }: ChatPreviewProps) {
  return (
    <Region role="status" aria-live="polite" aria-label={strings.chat.preview}>
      {message && (
        <Bubble key={message.id}>
          <Open type="button" onClick={onOpen} aria-label={strings.chat.previewOpen(message.name)}>
            <Name>{message.name}</Name>
            <Text>{message.file ? strings.chat.file.message(message.file.name) : message.text}</Text>
          </Open>
          <Close type="button" aria-label={strings.common.close} onClick={onDismiss}>
            <CloseIcon />
          </Close>
        </Bubble>
      )}
    </Region>
  )
}

const rise = keyframes`
  from {
    opacity: 0;
    transform: translateY(6px);
  }
`

const Region = styled.div`
  position: fixed;
  /* Above the toolbar (54 px + its padding), at the chat button's end */
  right: max(${space(4)}, env(safe-area-inset-right));
  bottom: calc(${space(20)} + env(safe-area-inset-bottom));
  z-index: ${layer.toast};
  pointer-events: none;

  @media ${media.phone} {
    left: max(${space(2)}, env(safe-area-inset-left));
    right: max(${space(2)}, env(safe-area-inset-right));
    bottom: calc(${space(16)} + env(safe-area-inset-bottom));
  }
`

const Bubble = styled.div`
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  max-width: 320px;
  border: 1px solid ${color.line};
  border-radius: ${radius.panel} ${radius.panel} ${radius.nameplate} ${radius.panel};
  background: ${color.surface};
  box-shadow: 0 8px 24px ${color.shadow};
  animation: ${rise} ${motion.base} ease-out;

  @media ${media.phone} {
    max-width: none;
  }
`

const Open = styled.button`
  flex: 1;
  min-width: 0;
  display: grid;
  gap: ${space(0.5)};
  padding: ${space(3)} ${space(1)} ${space(3)} ${space(4)};
  border: none;
  background: transparent;
  color: ${color.fg};
  font: inherit;
  text-align: left;
  cursor: pointer;
`

const Name = styled.span`
  color: ${color.primary};
  font-size: ${fontSize.toolbarLabel};
  font-weight: 700;
`

const Text = styled.span`
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  font-size: ${fontSize.small};
  overflow-wrap: anywhere;
`

const Close = styled.button`
  display: inline-grid;
  place-items: center;
  flex: none;
  width: 36px;
  height: 36px;
  margin: ${space(1)};
  border: none;
  border-radius: ${radius.button};
  background: transparent;
  color: ${color.muted};
  cursor: pointer;

  svg {
    width: 16px;
    height: 16px;
  }
`
