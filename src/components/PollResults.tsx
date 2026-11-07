import styled from 'styled-components'
import { percentOf, type PollVoter } from '../../shared/interact.ts'
import { strings } from '../strings.ts'
import { color, fontSize, radius, space } from '../styles/tokens.ts'

export interface PollResultsProps {
  options: readonly string[]
  counts: readonly number[]
  voters: number
  /** Who voted what, on a poll that is not anonymous */
  votes?: readonly PollVoter[]
}

/**
 * A poll's results (e5-t07): live in the 互動 panel, and for good in the chat once it ended. Numbers
 * and words on every row, so the bars are never the only way to read them. With several choices the
 * percents are of who voted, so they need not add up to 100.
 */
export function PollResults({ options, counts, voters, votes }: PollResultsProps) {
  return (
    <Rows aria-label={strings.poll.results}>
      {options.map((option, index) => {
        const count = counts[index] ?? 0
        const percent = percentOf(count, voters)
        const names = votes?.filter((vote) => vote.choices.includes(index)).map((vote) => vote.name)
        return (
          <Row key={index}>
            <Line>
              <span>{option}</span>
              <Count>{strings.poll.count(count, percent)}</Count>
            </Line>
            <Track aria-hidden="true">
              <Fill style={{ width: `${percent}%` }} />
            </Track>
            {names && names.length > 0 && <Names>{names.join(strings.poll.nameSeparator)}</Names>}
          </Row>
        )
      })}
    </Rows>
  )
}

const Rows = styled.ul`
  display: grid;
  gap: ${space(2)};
  margin: 0;
  padding: 0;
  list-style: none;
`

const Row = styled.li`
  display: grid;
  gap: ${space(1)};
`

const Line = styled.div`
  display: flex;
  justify-content: space-between;
  gap: ${space(2)};
  font-size: ${fontSize.small};
  overflow-wrap: anywhere;
`

const Count = styled.span`
  flex: none;
  color: ${color.muted};
  font-variant-numeric: tabular-nums;
`

const Track = styled.div`
  height: 6px;
  overflow: hidden;
  border-radius: ${radius.pill};
  background: ${color.line};
`

const Fill = styled.div`
  height: 100%;
  border-radius: ${radius.pill};
  background: ${color.primary};
`

const Names = styled.div`
  color: ${color.muted};
  font-size: ${fontSize.toolbarLabel};
  overflow-wrap: anywhere;
`
