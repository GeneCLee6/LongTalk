import styled from 'styled-components'
import { strings } from '../strings.ts'
import { color, fontSize, media, radius, space } from '../styles/tokens.ts'
import { Button } from './Button.tsx'
import { ScreenShareIcon } from './icons.tsx'

/**
 * 「你正在分享」 (e3-t03, AC-3.3): the bar the sharer sees above the stage while sharing, with one
 * of the three ways to stop (the others: the toolbar, and the browser's own stop button)
 */
export function SharingBar({ onStop }: { onStop: () => void }) {
  return (
    <Bar role="region" aria-label={strings.screenShare.youAreSharing}>
      <Live aria-hidden="true">
        <ScreenShareIcon />
      </Live>
      <Text>
        <strong>{strings.screenShare.youAreSharing}</strong>
        <span>{strings.screenShare.youAreSharingHint}</span>
      </Text>
      <Button variant="danger" onClick={onStop}>
        {strings.screenShare.stop}
      </Button>
    </Bar>
  )
}

const Bar = styled.div`
  flex: none;
  display: flex;
  align-items: center;
  gap: ${space(3)};
  align-self: center;
  max-width: 100%;
  padding: ${space(1.5)} ${space(1.5)} ${space(1.5)} ${space(3)};
  border: 1px solid ${color.primary};
  border-radius: ${radius.pill};
  background: ${color.primarySoft};
  color: ${color.fg};
  font-size: ${fontSize.small};

  @media ${media.phone} {
    border-radius: ${radius.button};
  }
`

const Live = styled.span`
  display: inline-flex;
  flex: none;
  width: 20px;
  height: 20px;
  color: ${color.primary};

  svg {
    width: 100%;
    height: 100%;
  }
`

const Text = styled.span`
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: ${space(2)};
  min-width: 0;

  span {
    color: ${color.muted};
  }
`
