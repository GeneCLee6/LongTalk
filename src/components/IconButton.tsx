import type { ButtonHTMLAttributes, ReactNode } from 'react'
import styled, { css } from 'styled-components'
import { strings } from '../strings.ts'
import { color, fontSize, motion, radius, size, media, space } from '../styles/tokens.ts'

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Accessible name, and the visible caption when `showLabel` is set (from strings.ts) */
  label: string
  icon: ReactNode
  /**
   * Show the caption under the icon (the toolbar on desktop; DESIGN.md §5 hides it on phones).
   * The label stays the accessible name either way.
   */
  showLabel?: boolean
  /** A count in a small pill on the icon's corner (participants, unread messages) */
  badge?: number
  /** `warn`: the badge asks for attention (people in the waiting room, F2) */
  badgeTone?: 'primary' | 'warn'
  /** The visible caption when it is shorter than the accessible name (defaults to `label`) */
  caption?: string
  /**
   * For on/off buttons (mic, camera): sets aria-pressed. `false` is the "off" state, which the
   * toolbar shows as a red button (DESIGN.md §5)
   */
  pressed?: boolean
  tone?: 'neutral' | 'danger'
  /**
   * The keyboard shortcut (G4, e4-t13): in the tooltip (「靜音（M）」) and as aria-keyshortcuts;
   * the accessible name stays the label
   */
  shortcut?: string
}

/** Square icon button, 44×44 (48×48 on phones), for the toolbar and panels */
export function IconButton({
  label,
  icon,
  showLabel = false,
  badge,
  badgeTone = 'primary',
  caption = label,
  pressed,
  tone = 'neutral',
  shortcut,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const off = pressed === false
  return (
    <Wrapper
      type={type}
      aria-label={label}
      aria-pressed={pressed}
      title={shortcut ? strings.shortcuts.tooltip(label, shortcut) : label}
      aria-keyshortcuts={shortcut}
      $danger={tone === 'danger' || off}
      {...rest}
    >
      <Icon aria-hidden="true">
        {icon}
        {badge !== undefined && <Badge $warn={badgeTone === 'warn'}>{badge}</Badge>}
      </Icon>
      {showLabel && <Caption aria-hidden="true">{caption}</Caption>}
    </Wrapper>
  )
}

const Wrapper = styled.button<{ $danger: boolean }>`
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: ${space(1)};
  min-width: ${size.toolbarButton};
  min-height: ${size.toolbarButton};
  padding: ${space(1)} ${space(2)};
  border: none;
  border-radius: ${radius.button};
  color: ${color.fg};
  background: transparent;
  cursor: pointer;
  transition: box-shadow ${motion.fast};

  ${({ $danger }) =>
    $danger &&
    css`
      background: ${color.danger};
      color: ${color.onDanger};
    `}

  &:hover:not(:disabled) {
    box-shadow: inset 0 0 0 999px ${color.hover};
  }
  &:active:not(:disabled) {
    box-shadow: inset 0 0 0 999px ${color.pressed};
  }
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  /* Not there yet ("coming soon"): looks off, but a click still explains why */
  &[aria-disabled='true'] {
    opacity: 0.5;
  }

  @media ${media.phone} {
    min-width: ${size.toolbarButtonTouch};
    min-height: ${size.toolbarButtonTouch};
  }
`

const Icon = styled.span`
  position: relative;
  display: inline-flex;
  width: 24px;
  height: 24px;

  svg {
    width: 100%;
    height: 100%;
  }
`

const Caption = styled.span`
  font-size: ${fontSize.toolbarLabel};
  line-height: 1;
  white-space: nowrap;

  @media ${media.phone} {
    display: none;
  }
`

const Badge = styled.span<{ $warn: boolean }>`
  position: absolute;
  top: -${space(1.5)};
  right: -${space(2.5)};
  min-width: 18px;
  padding: 0 ${space(1)};
  border-radius: ${radius.pill};
  background: ${({ $warn }) => ($warn ? color.warn : color.primary)};
  color: ${({ $warn }) => ($warn ? color.bg : color.onPrimary)};
  font-size: ${fontSize.badge};
  font-weight: 800;
  line-height: 18px;
  text-align: center;
  font-variant-numeric: tabular-nums;
`
