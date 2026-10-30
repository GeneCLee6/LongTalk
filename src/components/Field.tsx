import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'
import { useId } from 'react'
import styled, { css } from 'styled-components'
import { color, fontSize, radius, space } from '../styles/tokens.ts'

const control = css`
  width: 100%;
  min-height: 44px;
  padding: ${space(2)} ${space(3)};
  border: 1px solid ${color.line};
  border-radius: ${radius.button};
  background: ${color.surface2};
  color: ${color.fg};
  font-size: ${fontSize.base};

  &::placeholder {
    color: ${color.muted};
  }
  &:disabled {
    opacity: 0.5;
  }
`

export const TextInput = styled.input`
  ${control}
`

export const Select = styled.select`
  ${control}
  cursor: pointer;
`

/** A labelled text input; the label is visible above it */
export function TextField({
  label,
  ...rest
}: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId()
  return (
    <Label htmlFor={id}>
      {label}
      <TextInput id={id} {...rest} />
    </Label>
  )
}

/** A labelled select */
export function SelectField({
  label,
  children,
  ...rest
}: { label: string; children: ReactNode } & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId()
  return (
    <Label htmlFor={id}>
      {label}
      <Select id={id} {...rest}>
        {children}
      </Select>
    </Label>
  )
}

const Label = styled.label`
  display: grid;
  gap: ${space(1.5)};
  font-size: ${fontSize.small};
  color: ${color.muted};
`
