import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import styled from 'styled-components'
import { color, font, fontSize, radius, space } from '../styles/tokens.ts'

// The account pages' building blocks (I2's /me, I3's scheduled meetings and the public /m/<id>
// page): one look for all three.

export const Page = styled.main`
  min-height: 100dvh;
  font-family: ${font.current};
  background: ${color.bg};
  color: ${color.fg};

  a {
    color: ${color.primary};
  }
`

export const Top = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: ${space(4)};
  max-width: 760px;
  margin: 0 auto;
`

export const Content = styled.div`
  display: grid;
  gap: ${space(4)};
  max-width: 760px;
  margin: 0 auto;
  padding: 0 ${space(4)} ${space(7)};

  h1 {
    margin: 0;
    font-size: ${fontSize.title};
  }
`

export const Card = styled.section`
  display: grid;
  gap: ${space(3)};
  padding: ${space(5)};
  border: 1px solid ${color.line};
  border-radius: ${radius.panel};
  background: ${color.surface};

  h2 {
    margin: 0;
    font-size: 20px;
  }
  h3 {
    margin: 0;
    font-size: ${fontSize.base};
  }
`

export const Header = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: ${space(3)};
  font-weight: 600;
`

export const Form = styled.form`
  display: grid;
  gap: ${space(3)};
  padding-top: ${space(3)};
  border-top: 1px solid ${color.line};

  h3 {
    margin: 0;
    font-size: ${fontSize.base};
  }
`

export const Row = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: ${space(3)};

  > label {
    flex: 1 1 240px;
  }
`

export const List = styled.ul`
  display: grid;
  gap: ${space(2)};
  margin: 0;
  padding: 0;
  list-style: none;
`

export const Item = styled.li`
  display: grid;
  gap: ${space(2)};
  padding: ${space(3)};
  border: 1px solid ${color.line};
  border-radius: ${radius.tile};
`

export const ItemHead = styled.div`
  display: grid;
  gap: ${space(1)};
  min-width: 0;
`

export const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: ${space(2)};
`

export const Check = styled.label`
  display: flex;
  align-items: center;
  gap: ${space(2)};
  min-height: 32px;

  input {
    width: 20px;
    height: 20px;
    accent-color: ${color.primary};
  }
`

export const Muted = styled.p`
  margin: 0;
  color: ${color.muted};
`

export const Small = styled.span`
  font-size: ${fontSize.small};
  color: ${color.muted};
`

export const Mono = styled.span`
  font-family: ${font.mono};
  font-size: ${fontSize.small};
  overflow-wrap: anywhere;
`

export const Message = styled.p<{ $tone: 'error' | 'ok' }>`
  margin: 0;
  font-weight: 600;
  color: ${({ $tone }) => ($tone === 'error' ? color.danger : color.fg)};
`

/** Turnstile's widget, when it asks for a click; takes no room while empty */
export const Challenge = styled.div`
  &:empty {
    display: none;
  }
`

export const StyledLink = styled(Link)`
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0 ${space(4)};
  border-radius: ${radius.button};
  background: ${color.primary};
  color: ${color.onPrimary} !important;
  font-weight: 600;
  text-decoration: none;
`

/** A link that looks like the primary button */
export function ButtonLink({ to, children }: { to: string; children: ReactNode }) {
  return <StyledLink to={to}>{children}</StyledLink>
}

/** A link to another site that looks like the secondary button (calendar links: new tab) */
export const OutLink = styled.a`
  display: inline-flex;
  align-items: center;
  min-height: 40px;
  padding: ${space(2)} ${space(4)};
  border: 1px solid ${color.line};
  border-radius: ${radius.button};
  background: ${color.surface2};
  color: ${color.fg} !important;
  font-weight: 600;
  text-decoration: none;

  &:hover {
    box-shadow: inset 0 0 0 999px ${color.hover};
  }
`

/** A multi-line text input in the look of Field.tsx's */
export const TextArea = styled.textarea`
  width: 100%;
  min-height: 88px;
  padding: ${space(2)} ${space(3)};
  border: 1px solid ${color.line};
  border-radius: ${radius.button};
  background: ${color.surface2};
  color: ${color.fg};
  font: inherit;
  font-size: ${fontSize.base};
  resize: vertical;
`

/** A label above its control, like Field.tsx's */
export const FieldLabel = styled.label`
  display: grid;
  gap: ${space(1.5)};
  font-size: ${fontSize.small};
  color: ${color.muted};
`

/** Fields side by side on a wide screen, stacked on a phone */
export const FieldRow = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: ${space(3)};
`
