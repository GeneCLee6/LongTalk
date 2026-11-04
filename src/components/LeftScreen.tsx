import { useState } from 'react'
import styled from 'styled-components'
import { RATING_SCORES, type RatingScore } from '../../shared/telemetry.ts'
import { strings } from '../strings.ts'
import { color, fontSize, media, motion, radius, space } from '../styles/tokens.ts'
import { Button } from './Button.tsx'
import { LogoMark } from './Logo.tsx'

export interface LeftScreenProps {
  /**
   * `left`: the person pressed 「離開」 (rejoin offered); `closed`: the room closed while they were
   * away from it; `ended`: the host ended the meeting; `removed`: the host removed them, or their
   * browser is still banned (F1); `endedSelf`: we ended it for everyone (F3). Nothing to rejoin
   * but after `left`.
   */
  reason: 'left' | 'closed' | 'ended' | 'endedSelf' | 'removed' | 'declined'
  /** The room's name as the top bar showed it */
  roomName: string
  /** The one question's answer, given at most once (the page sends it as telemetry) */
  onRate: (score: RatingScore) => void
  onRejoin: () => void
  /**
   * A persistent room's meeting ended (I2): the room is still there, so 重新加入 starts the next
   * meeting
   */
  persistent?: boolean
  onHome: () => void
}

/**
 * The after-leave screen (e4-t18, DESIGN.md §4.3): what happened, one question about the call's
 * quality (1–5, nothing typed, nothing that identifies anyone), 「重新加入」 back through the
 * pre-join screen and 「回首頁」.
 */
export function LeftScreen({
  reason,
  roomName,
  onRate,
  onRejoin,
  onHome,
  persistent = false,
}: LeftScreenProps) {
  const [rated, setRated] = useState<RatingScore | null>(null)
  // `declined` (I4): did not agree to the recording; joining again asks again. A persistent
  // room (I2) outlives an ended meeting
  const closed =
    reason !== 'left' &&
    reason !== 'declined' &&
    !(persistent && (reason === 'ended' || reason === 'endedSelf'))
  const heading = {
    left: strings.left.title,
    closed: strings.left.closedTitle,
    ended: strings.left.endedTitle,
    endedSelf: strings.left.endedSelfTitle,
    removed: strings.left.removedTitle,
    declined: strings.left.declinedTitle,
  }[reason]
  const body = {
    left: strings.left.body(roomName),
    closed: strings.left.closedBody,
    ended: strings.left.endedBody(roomName),
    endedSelf: strings.left.endedSelfBody(roomName),
    removed: strings.left.removedBody(roomName),
    declined: strings.left.declinedBody(roomName),
  }[reason]
  const rate = (score: RatingScore) => {
    if (rated !== null) return
    setRated(score)
    onRate(score)
  }
  return (
    <Card aria-labelledby="left-title">
      <LogoMark size={40} />
      <h1 id="left-title">{heading}</h1>
      <Body>{body}</Body>

      <Rating role="group" aria-labelledby="left-question">
        <h2 id="left-question">{strings.left.question}</h2>
        <Scores>
          {RATING_SCORES.map((score) => (
            <li key={score}>
              <Score
                type="button"
                aria-label={strings.left.scoreLabel(score, strings.left.scores[score])}
                aria-pressed={rated === score}
                disabled={rated !== null}
                $chosen={rated === score}
                onClick={() => rate(score)}
              >
                {score}
              </Score>
              <ScoreName aria-hidden="true">{strings.left.scores[score]}</ScoreName>
            </li>
          ))}
        </Scores>
        <Small role="status">{rated === null ? strings.left.privacy : strings.left.thanks}</Small>
      </Rating>

      <Actions>
        {!closed && <Button onClick={onRejoin}>{strings.left.rejoin}</Button>}
        <Button variant={closed ? 'primary' : 'secondary'} onClick={onHome}>
          {strings.left.home}
        </Button>
      </Actions>
    </Card>
  )
}

const Card = styled.section`
  display: grid;
  justify-items: center;
  gap: ${space(4)};
  width: min(100% - ${space(8)}, 440px);
  padding: ${space(8)} ${space(6)};
  border: 1px solid ${color.line};
  border-radius: ${radius.panel};
  background: ${color.surface};
  text-align: center;

  h1 {
    margin: 0;
    font-size: 22px;
  }

  @media ${media.phone} {
    padding: ${space(6)} ${space(4)};
  }
`

const Body = styled.p`
  margin: 0;
  color: ${color.muted};
  line-height: 1.6;
  overflow-wrap: anywhere;
`

const Rating = styled.div`
  display: grid;
  justify-items: center;
  gap: ${space(3)};
  width: 100%;
  padding-top: ${space(4)};
  border-top: 1px solid ${color.line};

  h2 {
    margin: 0;
    font-size: ${fontSize.base};
    font-weight: 600;
  }
`

const Scores = styled.ul`
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: ${space(2)};
  width: 100%;
  margin: 0;
  padding: 0;
  list-style: none;

  li {
    display: grid;
    justify-items: center;
    gap: ${space(1)};
  }
`

const Score = styled.button<{ $chosen: boolean }>`
  width: 100%;
  max-width: 56px;
  aspect-ratio: 1;
  border: 1px solid ${({ $chosen }) => ($chosen ? color.primary : color.line)};
  border-radius: ${radius.button};
  background: ${({ $chosen }) => ($chosen ? color.primary : color.surface2)};
  color: ${({ $chosen }) => ($chosen ? color.onPrimary : color.fg)};
  font-size: 18px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition:
    background ${motion.fast},
    border-color ${motion.fast};

  &:hover:not(:disabled) {
    border-color: ${color.primary};
  }
  &:focus-visible {
    outline: 2px solid ${color.focus};
    outline-offset: 2px;
  }
  &:disabled {
    cursor: default;
    opacity: ${({ $chosen }) => ($chosen ? 1 : 0.5)};
  }
`

const ScoreName = styled.span`
  color: ${color.muted};
  font-size: ${fontSize.toolbarLabel};
  white-space: nowrap;
`

const Small = styled.p`
  margin: 0;
  min-height: 1.5em;
  color: ${color.muted};
  font-size: ${fontSize.small};
`

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: ${space(3)};
`
