import { useEffect, useRef } from 'react'
import styled from 'styled-components'
import type { SelfCapture } from '../media/share.ts'
import type { ShareMode } from '../media/shareMode.ts'
import type { SharePreview } from '../room/useSharePreview.ts'
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
  /** 文字 or 動態 (e3-t06) and its switch; without it there is no switch */
  mode?: { value: ShareMode; onChange: (mode: ShareMode) => void } | null
  /** The screen keeps moving in 文字: the hint, with its two answers (e3-t06) */
  motionHint?: { onSwitch: () => void; onDismiss: () => void } | null
  /**
   * The presenter view's thumbnail (e3-t08): our own capture, sampled once a second. `off`: a
   * whole screen (or the meeting itself) is shared, so no picture, only a note
   */
  preview?: { sample: SharePreview; off: boolean } | null
  /** What we share shows the meeting (e3-t09): the warning, 換一個畫面 and 知道了 */
  selfCapture?: { kind: SelfCapture; onRepick: () => void; onDismiss: () => void } | null
  /** A line for the sharer: why the camera cannot be turned on while sharing here */
  note?: string | null
}

const MODES: { mode: ShareMode; label: () => string; hint: () => string }[] = [
  {
    mode: 'text',
    label: () => strings.screenShare.modeText,
    hint: () => strings.screenShare.modeTextHint,
  },
  {
    mode: 'motion',
    label: () => strings.screenShare.modeMotion,
    hint: () => strings.screenShare.modeMotionHint,
  },
]

/**
 * 「你正在分享」 (e3-t03, AC-3.3): the bar the sharer sees above the stage while sharing, with one
 * of the three ways to stop (the others: the toolbar, and the browser's own stop button), the
 * switch for the share's sound (e3-t04, AC-3.2) when there is any, the 文字／動態 switch (e3-t06,
 * AC-3.4) and a small preview of what is shared (the presenter view, e3-t08, AC-3.6). Under it,
 * when they apply, the hint to switch to 動態 and the warning that the meeting itself is shared
 * (e3-t09).
 */
export function SharingBar({
  onStop,
  audio = null,
  mode = null,
  motionHint = null,
  preview = null,
  selfCapture = null,
  note = null,
}: SharingBarProps) {
  const hint = !audio
    ? strings.screenShare.youAreSharingHint
    : audio.on
      ? strings.screenShare.withAudioHint
      : strings.screenShare.audioOffHint
  const notices = motionHint !== null || selfCapture !== null
  const showThumb = preview !== null && !preview.off && preview.sample.canvas !== null
  return (
    <Bar role="region" aria-label={strings.screenShare.youAreSharing} $stacked={notices}>
      <Row>
        {showThumb ? (
          <Thumbnail sample={preview.sample} />
        ) : (
          <Live aria-hidden="true">
            <ScreenShareIcon />
          </Live>
        )}
        <Text>
          <strong>{strings.screenShare.youAreSharing}</strong>
          <span>{hint}</span>
          {preview?.off && <span>{strings.screenShare.previewOff}</span>}
          {note && <span>{note}</span>}
        </Text>
        {mode && (
          <Modes role="group" aria-label={strings.screenShare.mode}>
            {MODES.map((entry) => (
              <ModeButton
                key={entry.mode}
                type="button"
                aria-pressed={mode.value === entry.mode}
                title={entry.hint()}
                onClick={() => mode.onChange(entry.mode)}
              >
                {entry.label()}
              </ModeButton>
            ))}
          </Modes>
        )}
        {audio && (
          <Button variant="secondary" onClick={audio.onToggle}>
            <Glyph aria-hidden="true">{audio.on ? <SoundIcon /> : <SoundOffIcon />}</Glyph>
            {audio.on ? strings.screenShare.audioOn : strings.screenShare.audioOff}
          </Button>
        )}
        <Button variant="danger" onClick={onStop}>
          {strings.screenShare.stop}
        </Button>
      </Row>
      {selfCapture && (
        <Notice role="alert" $warn>
          <span>{strings.screenShare.selfCapture[selfCapture.kind]}</span>
          <Button variant="primary" onClick={selfCapture.onRepick}>
            {strings.screenShare.repick}
          </Button>
          <Button variant="ghost" onClick={selfCapture.onDismiss}>
            {strings.screenShare.selfCaptureDismiss}
          </Button>
        </Notice>
      )}
      {motionHint && (
        <Notice role="status" $warn={false}>
          <span>{strings.screenShare.motionHint}</span>
          <Button variant="primary" onClick={motionHint.onSwitch}>
            {strings.screenShare.motionSwitch}
          </Button>
          <Button variant="ghost" onClick={motionHint.onDismiss}>
            {strings.screenShare.motionDismiss}
          </Button>
        </Notice>
      )}
    </Bar>
  )
}

/** The presenter view's picture: the sampler's latest frame, drawn again on every new one */
function Thumbnail({ sample }: { sample: SharePreview }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const target = ref.current
    const source = sample.canvas
    if (!target || !source) return
    if (target.width !== source.width || target.height !== source.height) {
      target.width = source.width
      target.height = source.height
    }
    target.getContext('2d')?.drawImage(source, 0, 0)
  }, [sample])
  return (
    <Thumb ref={ref} role="img" aria-label={strings.screenShare.preview} data-share-preview="" />
  )
}

const Bar = styled.div<{ $stacked: boolean }>`
  flex: none;
  display: flex;
  flex-direction: column;
  gap: ${space(2)};
  align-self: center;
  max-width: 100%;
  padding: ${space(1.5)} ${space(1.5)} ${space(1.5)} ${space(3)};
  border: 1px solid ${color.primary};
  border-radius: ${({ $stacked }) => ($stacked ? radius.panel : radius.pill)};
  background: ${color.primarySoft};
  color: ${color.fg};
  font-size: ${fontSize.small};

  @media ${media.phone} {
    border-radius: ${radius.button};
  }
`

const Row = styled.div`
  display: flex;
  align-items: center;
  gap: ${space(3)};

  @media ${media.phone} {
    flex-wrap: wrap;
    row-gap: ${space(2)};
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

/** 16:9 at most 96 × 54: small enough never to read as the share itself */
const Thumb = styled.canvas`
  flex: none;
  width: 96px;
  max-height: 54px;
  object-fit: contain;
  border-radius: ${radius.nameplate};
  background: ${color.tileTo};
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

/** 文字｜動態: two buttons in one pill, the chosen one filled */
const Modes = styled.div`
  flex: none;
  display: inline-flex;
  padding: 2px;
  border: 1px solid ${color.line};
  border-radius: ${radius.pill};
  background: ${color.surface};
`

const ModeButton = styled.button`
  min-height: 36px;
  padding: ${space(1)} ${space(3)};
  border: 0;
  border-radius: ${radius.pill};
  background: transparent;
  color: ${color.fg};
  font: inherit;
  font-weight: 600;
  cursor: pointer;

  &:hover {
    background: ${color.hover};
  }

  &[aria-pressed='true'] {
    background: ${color.primary};
    color: ${color.onPrimary};
  }
`

const Notice = styled.div<{ $warn: boolean }>`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: ${space(2)};
  padding: ${space(2)} ${space(3)};
  border-radius: ${radius.button};
  border-left: 4px solid ${({ $warn }) => ($warn ? color.warn : color.primary)};
  background: ${color.surface};
  color: ${color.fg};

  span {
    flex: 1 1 16em;
  }
`
