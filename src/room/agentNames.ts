import type { Member, RoomView } from '../../shared/protocol.ts'
import { strings, type Strings } from '../strings.ts'

/** The two names below, from one dictionary */
type AgentText = Pick<Strings['agent'], 'computerOf' | 'computerNamed'>

/**
 * What a desktop agent (N2, e9-t02; `Member.agent`) is called: 「<owner's name> 的電腦」, the owner
 * looked up in `members`; once the owner is gone (null, or not in the view), the computer's own
 * name, marked as a computer. A person's name as it is.
 */
export function memberLabel(
  member: Member,
  members: Readonly<Record<string, Member>>,
  text: AgentText = strings.agent,
): string {
  const agent = member.agent
  if (!agent) return member.name
  const owner = agent.owner === null ? undefined : members[agent.owner]
  return owner && !owner.agent ? text.computerOf(owner.name) : text.computerNamed(agent.device)
}

/**
 * The view with every agent's `name` replaced by memberLabel, so each place that shows a member's
 * name (tiles, the participants list, the share's tag, toasts) says whose computer it is without
 * knowing about agents. The same object back when there is no agent in it. Read from the whole
 * room's view (an owner in another breakout room still names theirs). `text`: the language's.
 */
export function nameAgents(view: RoomView, text: AgentText = strings.agent): RoomView {
  const members = view.members
  let named: Record<string, Member> | null = null
  for (const [id, member] of Object.entries(members)) {
    if (!member.agent) continue
    const name = memberLabel(member, members, text)
    if (name === member.name) continue
    named ??= { ...members }
    named[id] = { ...member, name }
  }
  return named ? { ...view, members: named } : view
}
