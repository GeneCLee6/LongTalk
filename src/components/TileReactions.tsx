import styled, { css, keyframes } from 'styled-components'
import { REACTION_FLOAT_MS } from '../../shared/reactions.ts'
import type { FloatingReaction } from '../room/floatingReactions.ts'
import { strings } from '../strings.ts'
import { color, fontSize, radius, space } from '../styles/tokens.ts'
import { useReducedMotion } from './layoutContext.ts'

export interface TileReactionsProps {
  /** Whose reactions (their name, for the bubbles' accessible names) */
  name: string
  reactions: readonly FloatingReaction[]
}

/**
 * The reactions over one tile (G3, e5-t03; DESIGN.md §6): each bubble rises from the lower middle
 * with a small random sideways drift and fades out over REACTION_FLOAT_MS; a burst of the same
 * one is one bubble with 「×N」. With prefers-reduced-motion nothing moves: the newest is a still
 * badge for a moment (the hook keeps it REACTION_BADGE_MS). Never takes a click: the tile's
 * buttons stay usable under it.
 */
export function TileReactions({ name, reactions }: TileReactionsProps) {
  const still = useReducedMotion()
  if (reactions.length === 0) return null
  const shown = still ? reactions.slice(-1) : reactions
  return (
    <Layer data-reactions>
      {shown.map((bubble) => (
        <Bubble
          key={bubble.key}
          role="img"
          aria-label={strings.reactions.from(
            name,
            strings.reactions.names[bubble.emoji],
            bubble.count,
          )}
          $still={still}
          style={still ? undefined : { left: `${50 + bubble.drift * 22}%` }}
        >
          <span aria-hidden="true">{bubble.emoji}</span>
          {bubble.count > 1 && <Count aria-hidden="true">×{bubble.count}</Count>}
        </Bubble>
      ))}
    </Layer>
  )
}

const rise = keyframes`
  0% { bottom: 12%; opacity: 0; transform: translateX(-50%) scale(0.6); }
  8% { opacity: 1; transform: translateX(-50%) scale(1.1); }
  14% { transform: translateX(-50%) scale(1); }
  75% { opacity: 1; }
  100% { bottom: 78%; opacity: 0; transform: translateX(-50%) scale(1); }
`

const Layer = styled.div`
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
`

const Bubble = styled.span<{ $still: boolean }>`
  position: absolute;
  display: inline-flex;
  align-items: center;
  gap: ${space(1)};
  padding: ${space(1)} ${space(2)};
  border-radius: ${radius.pill};
  background: ${color.overlay};
  font-size: clamp(22px, 5vmin, 34px);
  line-height: 1.1;
  white-space: nowrap;

  ${({ $still }) =>
    $still
      ? css`
          left: 50%;
          bottom: 22%;
          transform: translateX(-50%);
        `
      : css`
          bottom: 12%;
          opacity: 0;
          animation: ${rise} ${REACTION_FLOAT_MS}ms ease-out forwards;
        `}
`

const Count = styled.span`
  color: ${color.fg};
  font-size: ${fontSize.small};
  font-weight: 700;
`

export interface OffStageReactionsProps {
  /** Reactions from members whose tile is not on the stage (hidden), with their names */
  entries: readonly { name: string; bubble: FloatingReaction }[]
}

/**
 * Reactions from someone whose tile is not on the stage (隱藏自己, 隱藏沒有視訊的人): a column of
 * small still chips at the stage's lower left, 「Bob 👍」, gone with the bubble. Never takes a
 * click.
 */
export function OffStageReactions({ entries }: OffStageReactionsProps) {
  if (entries.length === 0) return null
  return (
    <Lane data-reactions="off-stage">
      {entries.map(({ name, bubble }) => (
        <Chip
          key={bubble.key}
          role="img"
          aria-label={strings.reactions.from(
            name,
            strings.reactions.names[bubble.emoji],
            bubble.count,
          )}
        >
          <ChipName aria-hidden="true">{name}</ChipName>
          <span aria-hidden="true">{bubble.emoji}</span>
          {bubble.count > 1 && <Count aria-hidden="true">×{bubble.count}</Count>}
        </Chip>
      ))}
    </Lane>
  )
}

const Lane = styled.div`
  position: absolute;
  left: ${space(2)};
  bottom: ${space(2)};
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: ${space(1)};
  max-width: 50%;
  pointer-events: none;
`

const Chip = styled.span`
  display: inline-flex;
  align-items: center;
  gap: ${space(1)};
  max-width: 100%;
  padding: ${space(1)} ${space(2)};
  border-radius: ${radius.pill};
  background: ${color.overlay};
  font-size: 20px;
  line-height: 1.1;
`

const ChipName = styled.span`
  overflow: hidden;
  color: ${color.fg};
  font-size: ${fontSize.small};
  white-space: nowrap;
  text-overflow: ellipsis;
`
