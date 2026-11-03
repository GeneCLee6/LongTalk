import { useEffect } from 'react'
import styled from 'styled-components'
import type { InstallOffer } from '../pwa/install.ts'
import { installOffers, useInstallOffer } from '../pwa/pwa.ts'
import { strings } from '../strings.ts'
import { color, fontSize, radius, space } from '../styles/tokens.ts'
import { Button } from './Button.tsx'
import { InstallIcon } from './icons.tsx'

export interface InstallCardProps {
  offer: InstallOffer
  onInstall: () => void
  onDismiss: () => void
}

/**
 * The home page's install offer (G4, e4-t12): one quiet line under the join box. Chromium:
 * 「安裝」 opens the browser's dialog; iOS Safari: how to add it from the share sheet. 不用了 /
 * 知道了 is remembered (install.ts).
 */
export function InstallCard({ offer, onInstall, onDismiss }: InstallCardProps) {
  if (!offer) return null
  const ios = offer === 'ios'
  return (
    <Card aria-label={strings.pwa.installLabel}>
      <InstallIcon />
      <Text>
        <b>{ios ? strings.pwa.iosTitle : strings.pwa.installTitle}</b>
        <span>{ios ? strings.pwa.iosBody : strings.pwa.installBody}</span>
      </Text>
      <Actions>
        <Button variant="ghost" onClick={onDismiss}>
          {ios ? strings.pwa.iosDismiss : strings.pwa.installDismiss}
        </Button>
        {!ios && (
          <Button variant="secondary" onClick={onInstall}>
            {strings.pwa.install}
          </Button>
        )}
      </Actions>
    </Card>
  )
}

/** The offer as install.ts keeps it; the iOS hint counts as shown once it is on screen */
export function InstallPrompt() {
  const offer = useInstallOffer()
  useEffect(() => {
    if (offer === 'ios') installOffers.shown()
  }, [offer])
  return (
    <InstallCard
      offer={offer}
      onInstall={() => void installOffers.install()}
      onDismiss={() => installOffers.dismiss()}
    />
  )
}

const Card = styled.aside`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: ${space(2)} ${space(3)};
  width: min(560px, 100%);
  padding: ${space(3)} ${space(4)};
  border: 1px solid ${color.line};
  border-radius: ${radius.tile};
  background: ${color.surface};
  text-align: left;

  > svg {
    flex: none;
    width: 22px;
    height: 22px;
    color: ${color.primary};
  }
`

const Text = styled.p`
  display: grid;
  flex: 1 1 240px;
  gap: ${space(0.5)};
  margin: 0;

  span {
    color: ${color.muted};
    font-size: ${fontSize.small};
  }
`

const Actions = styled.div`
  display: flex;
  margin-left: auto;
  gap: ${space(2)};
`
