import styled from 'styled-components'
import type { AgendaInfo } from '../../shared/interact.ts'
import { strings } from '../strings.ts'
import { color, fontSize, media, radius, space } from '../styles/tokens.ts'
import { usePhoneLayout } from './layoutContext.ts'

export interface AgendaBarProps {
  agenda: AgendaInfo
  /** A host or co-host moves it along (RoomDO checks again); absent for everyone else */
  onCurrent?: (index: number) => void
}

/**
 * The agenda over the stage (e5-t08): every item with its planned time, the current one marked for
 * everyone, by colour, weight and aria-current. A phone has room for the current item alone.
 */
export function AgendaBar({ agenda, onCurrent }: AgendaBarProps) {
  const phone = usePhoneLayout() !== null
  const { items, current } = agenda
  const shown = items.flatMap((item, index) => (phone && index !== current ? [] : [{ item, index }]))
  return (
    <Bar aria-label={strings.agenda.label}>
      {onCurrent && (
        <Move type="button" disabled={current === 0} onClick={() => onCurrent(current - 1)}>
          {strings.agenda.previous}
        </Move>
      )}
      <Items>
        {shown.map(({ item, index }) => (
          <Item key={index} $on={index === current} aria-current={index === current ? 'step' : undefined}>
            {phone && <Step>{strings.agenda.step(index + 1, items.length)}</Step>}
            <span>{item.title}</span>
            <Minutes>{strings.agenda.minutes(item.minutes)}</Minutes>
          </Item>
        ))}
      </Items>
      {onCurrent && (
        <Move
          type="button"
          disabled={current >= items.length - 1}
          onClick={() => onCurrent(current + 1)}
        >
          {strings.agenda.next}
        </Move>
      )}
    </Bar>
  )
}

const Bar = styled.nav`
  display: flex;
  flex: none;
  align-items: center;
  gap: ${space(2)};
  padding: ${space(1)} ${space(2)};
  border: 1px solid ${color.line};
  border-radius: ${radius.button};
  background: ${color.surface};
`

const Items = styled.ol`
  display: flex;
  flex: 1;
  gap: ${space(1)};
  min-width: 0;
  margin: 0;
  padding: 0;
  overflow-x: auto;
  list-style: none;
`

const Item = styled.li<{ $on: boolean }>`
  display: flex;
  flex: none;
  align-items: baseline;
  gap: ${space(1)};
  max-width: 280px;
  padding: ${space(1)} ${space(2)};
  border-radius: ${radius.pill};
  background: ${({ $on }) => ($on ? color.primarySoft : 'transparent')};
  color: ${({ $on }) => ($on ? color.fg : color.muted)};
  font-size: ${fontSize.small};
  font-weight: ${({ $on }) => ($on ? 700 : 400)};
  white-space: nowrap;

  span:not(:last-child) {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  @media ${media.phone} {
    flex: 1;
    max-width: none;
    min-width: 0;
  }
`

const Step = styled.span`
  flex: none;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
`

const Minutes = styled.span`
  flex: none;
  font-size: ${fontSize.toolbarLabel};
  font-weight: 400;
`

const Move = styled.button`
  flex: none;
  min-height: 32px;
  padding: 0 ${space(2)};
  border: none;
  border-radius: ${space(2)};
  background: transparent;
  color: ${color.primary};
  font: inherit;
  font-size: ${fontSize.small};
  white-space: nowrap;
  cursor: pointer;

  &:hover:not(:disabled) {
    background: ${color.hover};
  }
  &:disabled {
    color: ${color.muted};
    cursor: default;
  }

  @media ${media.phone} {
    min-height: 44px;
  }
`
