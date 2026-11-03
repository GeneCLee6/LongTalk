import styled from 'styled-components'
import { strings } from '../strings.ts'
import { color, space } from '../styles/tokens.ts'
import { Button } from './Button.tsx'
import { OfflineIcon } from './icons.tsx'

/**
 * 「你目前離線」 (G4, e4-t12, AC-4.7): the shell opened offline at a room's link. Joining needs
 * the network: the page tries again by itself once the browser is back online, or on 再試一次.
 */
export function OfflineScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <Panel role="status">
      <OfflineIcon />
      <h1>{strings.pwa.offlineTitle}</h1>
      <p>{strings.pwa.offlineRoom}</p>
      <Button variant="secondary" onClick={onRetry}>
        {strings.turnedAway.retry}
      </Button>
    </Panel>
  )
}

const Panel = styled.section`
  display: grid;
  justify-items: center;
  gap: ${space(3)};
  max-width: 420px;
  text-align: center;

  > svg {
    width: 40px;
    height: 40px;
    color: ${color.warn};
  }
  h1 {
    margin: 0;
    font-size: 22px;
  }
  p {
    margin: 0;
    color: ${color.muted};
    line-height: 1.6;
  }
`
