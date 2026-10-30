import type { ButtonHTMLAttributes, ReactNode } from 'react'
import styled, { css } from 'styled-components'
import { breakpoint, color, fontSize, motion, radius, size, space } from '../styles/tokens.ts'

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Accessible name, and the visible caption when `showLabel` is set (from strings.ts) */
  label: string
  icon: ReactNode
  /** Show the caption under the icon (toolbar on desktop; DESIGN.md §5 hides it on phones) */
  showLabel?: boolean
  /**
   * For on/off buttons (mic, camera): sets aria-pressed. `false` is the "off" state, which the
   * toolbar shows as a red button (DESIGN.md §5)
   */
  pressed?: boolean
  tone?: 'neutral' | 'danger'
}

/** Square icon button, 44×44 (48×48 on phones), for the toolbar and panels */
export function IconButton({
  label,
  icon,
  showLabel = false,
  pressed,
  tone = 'neutral',
  type = 'button',
  ...rest
}: IconButtonProps) {
  const off = pressed === false
  return (
    <Wrapper
      type={type}
      aria-label={showLabel ? undefined : label}
      aria-pressed={pressed}
      title={label}
      $danger={tone === 'danger' || off}
      {...rest}
    >
      <Icon aria-hidden="true">{icon}</Icon>
      {showLabel && <Caption>{label}</Caption>}
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

  @media (max-width: ${breakpoint.phone}) {
    min-width: ${size.toolbarButtonTouch};
    min-height: ${size.toolbarButtonTouch};
  }
`

const Icon = styled.span`
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
`
