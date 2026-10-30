import type { ButtonHTMLAttributes } from 'react'
import styled, { css } from 'styled-components'
import { color, fontSize, motion, radius, space } from '../styles/tokens.ts'

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  /** Stretch to the container's width (forms, phone layouts) */
  block?: boolean
}

/** Text button. `type` defaults to "button" so it never submits a form by accident. */
export function Button({
  variant = 'primary',
  block = false,
  type = 'button',
  ...rest
}: ButtonProps) {
  return <StyledButton type={type} $variant={variant} $block={block} {...rest} />
}

const variants = {
  primary: css`
    background: ${color.primary};
    color: ${color.onPrimary};
  `,
  secondary: css`
    background: ${color.surface2};
    color: ${color.fg};
    border-color: ${color.line};
  `,
  danger: css`
    background: ${color.danger};
    color: ${color.onDanger};
  `,
  ghost: css`
    background: transparent;
    color: ${color.fg};
  `,
}

const StyledButton = styled.button<{ $variant: ButtonVariant; $block: boolean }>`
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: ${space(2)};
  min-height: 40px;
  width: ${({ $block }) => ($block ? '100%' : 'auto')};
  padding: ${space(2)} ${space(4)};
  border: 1px solid transparent;
  border-radius: ${radius.button};
  font-size: ${fontSize.base};
  font-weight: 600;
  cursor: pointer;
  transition:
    filter ${motion.fast},
    box-shadow ${motion.fast};
  ${({ $variant }) => variants[$variant]}

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
`
