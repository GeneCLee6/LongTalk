import styled from 'styled-components'
import { strings } from '../strings.ts'
import { color, fontSize, media, radius, space } from '../styles/tokens.ts'
import { Button } from './Button.tsx'
import { ScreenShareIcon, SoundIcon, SoundOffIcon } from './icons.tsx'

export interface SharingBarProps {
  onStop: () => void
  /**
   * The share's sound (e3-t04), when the picker gave any: whether it is sent, and its switch.
   * Without it (a source with no sound, a browser that cannot capture it) there is no switch.
   */
  audio?: { on: boolean; onToggle: () => void } | null
}

/**
 * 「你正在分享」 (e3-t03, AC-3.3): the bar the sharer sees above the stage while sharing, with one
 * of the three ways to stop (the others: the toolbar, and the browser's own stop button), and
 * the switch for the share's sound (e3-t04, AC-3.2) when there is any
 */
export function SharingBar({ onStop, audio = null }: SharingBarProps) {
  const hint = !audio
    ? strings.screenShare.youAreSharingHint
    : audio.on
      ? strings.screenShare.withAudioHint
      : strings.screenShare.audioOffHint
  return (
    <Bar role="region" aria-label={strings.screenShare.youAreSharing}>
      <Live aria-hidden="true">
        <ScreenShareIcon />
      </Live>
      <Text>
        <strong>{strings.screenShare.youAreSharing}</strong>
        <span>{hint}</span>
      </Text>
      {audio && (
        <Button variant="secondary" onClick={audio.onToggle}>
          <Glyph aria-hidden="true">{audio.on ? <SoundIcon /> : <SoundOffIcon />}</Glyph>
          {audio.on ? strings.screenShare.audioOn : strings.screenShare.audioOff}
        </Button>
      )}
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
    flex-wrap: wrap;
    row-gap: ${space(2)};
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

const Glyph = styled.span`
  display: inline-flex;
  width: 18px;
  height: 18px;

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
