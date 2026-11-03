import type { ReactNode } from 'react'
import { useId, useState } from 'react'
import styled from 'styled-components'
import {
  GUIDE_IDS,
  GUIDES,
  type GuideId,
  type StepIcon,
  type SystemId,
} from '../room/permissionGuide.ts'
import { strings } from '../strings.ts'
import { color, fontSize, radius, space } from '../styles/tokens.ts'
import { Button } from './Button.tsx'
import { Select } from './Field.tsx'
import {
  CamOffIcon,
  LockIcon,
  MenuBarIcon,
  RefreshIcon,
  SettingsIcon,
  SlidersIcon,
  TextSizeIcon,
  ToggleIcon,
} from './icons.tsx'

export interface PermissionGuideProps {
  /** What the browser blocked */
  blocked: 'mic' | 'cam' | 'both'
  /** The browser allows it (Permissions API) but the system does not: system steps first */
  system: boolean
  /** The browser's steps shown first (detectGuide) */
  guide: GuideId
  /** The operating system's switch, when known (detectSystem) */
  systemId: SystemId | null
  /** The Permissions API reports changes: allowing it retries by itself */
  watching: boolean
  onRetry: () => void
}

const ICONS: Record<StepIcon, () => ReactNode> = {
  siteInfo: () => <SlidersIcon />,
  lock: () => <LockIcon />,
  toggle: () => <ToggleIcon />,
  blocked: () => <CamOffIcon />,
  menu: () => <MenuBarIcon />,
  textSize: () => <TextSizeIcon />,
  settings: () => <SettingsIcon />,
  retry: () => <RefreshIcon />,
}

/**
 * The permission tutorial (G1, e4-t09): text and an icon per step, for the browser we guess, with
 * a menu to see another browser's steps, the operating system's switch, and 再試一次
 */
export function PermissionGuide(props: PermissionGuideProps) {
  const [guide, setGuide] = useState<GuideId>(props.guide)
  const titleId = useId()
  const text = strings.permissionGuide
  const title = props.system
    ? text.titleSystem
    : props.blocked === 'mic'
      ? text.titleMic
      : props.blocked === 'cam'
        ? text.titleCam
        : text.titleBoth
  const systemStep = props.systemId ? text.system[props.systemId] : null
  return (
    <Card role="alert" aria-labelledby={titleId}>
      <h2 id={titleId}>{title}</h2>
      <p>{props.system ? text.introSystem : text.intro}</p>
      {props.system && systemStep && <SystemFirst>{systemStep}</SystemFirst>}
      <BrowserPick>
        <span id={`${titleId}-browser`}>{text.browserLabel}</span>
        <Select
          aria-labelledby={`${titleId}-browser`}
          value={guide}
          onChange={(event) => setGuide(event.target.value as GuideId)}
        >
          {GUIDE_IDS.map((id) => (
            <option key={id} value={id}>
              {text.browsers[id]}
            </option>
          ))}
        </Select>
      </BrowserPick>
      <Steps>
        {GUIDES[guide].map((step, i) => (
          <li key={step.text}>
            <StepIconBox aria-hidden="true">{ICONS[step.icon]()}</StepIconBox>
            <span>
              <StepNumber>{i + 1}.</StepNumber> {text.steps[step.text]}
            </span>
          </li>
        ))}
      </Steps>
      {!props.system && systemStep && (
        <Muted>
          <strong>{text.systemTitle}</strong> {systemStep}
        </Muted>
      )}
      <Actions>
        <Button onClick={props.onRetry}>{text.retry}</Button>
        {props.watching && <Muted>{text.watching}</Muted>}
      </Actions>
      <Muted>{text.withoutDevices}</Muted>
    </Card>
  )
}

const Card = styled.section`
  display: grid;
  gap: ${space(3)};
  padding: ${space(4)};
  border: 1px solid ${color.warn};
  border-radius: ${radius.panel};
  background: ${color.surface};
  font-size: ${fontSize.small};

  h2 {
    margin: 0;
    font-size: ${fontSize.base};
  }
  p {
    margin: 0;
  }
`

const SystemFirst = styled.p`
  padding: ${space(2)} ${space(3)};
  border-radius: ${radius.button};
  background: ${color.surface2};
`

const BrowserPick = styled.label`
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: ${space(2)};
  color: ${color.muted};
`

const Steps = styled.ol`
  display: grid;
  gap: ${space(2)};
  margin: 0;
  padding: 0;
  list-style: none;

  li {
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr);
    align-items: center;
    gap: ${space(3)};
  }
`

const StepIconBox = styled.span`
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: ${radius.button};
  background: ${color.surface2};
  color: ${color.primary};

  svg {
    width: 20px;
    height: 20px;
  }
`

const StepNumber = styled.span`
  font-weight: 600;
`

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: ${space(3)};
`

const Muted = styled.p`
  color: ${color.muted};
`
