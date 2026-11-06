import styled, { css } from 'styled-components'
import { color, fontSize, media, motion, radius, space } from '../styles/tokens.ts'

// What a share tile and the whiteboard have in common (J3): the frame, the tag top-left, the picker
// top-right, the controls bottom-right. In the room's first load with ShareTile; the whiteboard's
// lazy chunk imports them from here.

export const Frame = styled.figure<{ $grab: boolean; $interactive: boolean; $dragging?: boolean }>`
  position: relative;
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
  border-radius: ${radius.tile};
  background: ${color.tileTo};
  display: grid;
  place-items: center;
  color: ${color.fg};

  &:fullscreen {
    border-radius: 0;
  }

  ${({ $interactive }) =>
    $interactive &&
    css`
      /* The tile's own pinch and drag, not the browser's */
      touch-action: none;
    `}
  ${({ $grab, $dragging }) =>
    $grab &&
    css`
      cursor: ${$dragging ? 'grabbing' : 'grab'};
    `}
`

/** DESIGN.md §1: 分享＝藍色標籤 (the brand colour), with the name, never colour alone */
export const Tag = styled.figcaption`
  position: absolute;
  top: ${space(2.5)};
  left: ${space(2.5)};
  max-width: calc(100% - ${space(5)});
  padding: ${space(1)} ${space(2.5)};
  border-radius: ${radius.pill};
  background: ${color.primary};
  color: ${color.onPrimary};
  font-size: ${fontSize.nameplate};
  font-weight: 700;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  pointer-events: none;
`

/** The top bar's red light where fullscreen hides it: words, and a dot */
export const RecordingTag = styled.p`
  position: absolute;
  top: ${space(10)};
  left: ${space(2.5)};
  margin: 0;
  padding: ${space(1)} ${space(2.5)};
  border-radius: ${radius.pill};
  background: ${color.danger};
  color: ${color.onDanger};
  font-size: ${fontSize.nameplate};
  font-weight: 700;
  pointer-events: none;

  &::before {
    content: '● ';
  }
`

export const PickerSlot = styled.div`
  position: absolute;
  top: ${space(2)};
  right: ${space(2)};
  max-width: calc(100% - ${space(4)});
`

/**
 * Bottom right, out of the way of the name and the picker on top (and J2's toolbar, DESIGN.md
 * §4.3: 分享格上緣). Shown on hover or focus, always on touch and while the view is changed.
 */
export const Controls = styled.div<{ $pinned: boolean }>`
  position: absolute;
  right: ${space(2)};
  bottom: ${space(2)};
  display: flex;
  align-items: center;
  gap: ${space(0.5)};
  padding: ${space(0.5)};
  border-radius: ${radius.pill};
  background: ${color.overlay};
  cursor: default;
  opacity: ${({ $pinned }) => ($pinned ? 1 : 0)};
  transition: opacity ${motion.fast} ease-out;

  figure:hover &,
  &:focus-within,
  figure:focus-visible & {
    opacity: 1;
  }
  @media ${media.touchPrimary} {
    opacity: 1;
  }
`

const controlStyle = css`
  display: inline-grid;
  place-items: center;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: ${radius.pill};
  background: transparent;
  color: ${color.fg};
  cursor: pointer;

  &:hover:not(:disabled) {
    background: ${color.hover};
  }
  &:disabled {
    color: ${color.muted};
    cursor: default;
  }
  &[aria-pressed='true'] {
    background: ${color.primary};
    color: ${color.onPrimary};
  }
  @media ${media.touchPrimary} {
    height: 44px;
  }
`

export const Control = styled.button`
  ${controlStyle}
  width: 32px;

  svg {
    width: 18px;
    height: 18px;
  }
  @media ${media.touchPrimary} {
    width: 44px;
  }
`

export const Percent = styled.button`
  ${controlStyle}
  min-width: 44px;
  font-size: ${fontSize.nameplate};
  font-variant-numeric: tabular-nums;
`
