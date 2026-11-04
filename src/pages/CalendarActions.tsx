import { Button } from '../components/Button.tsx'
import { calendarLinks, downloadIcs, type MeetingTime } from '../meeting/invite.ts'
import { strings } from '../strings.ts'
import { Actions, OutLink } from './accountStyles.tsx'

/** .ics, Google, Outlook: the same row on /me and on /m/<id> */
export function CalendarActions({
  meeting,
  origin,
}: {
  meeting: MeetingTime
  origin: string
}) {
  return (
    <Actions role="group" aria-label={strings.meetings.calendars(meeting.title)}>
      <Button variant="secondary" onClick={() => downloadIcs(meeting, origin)}>
        {strings.meetings.downloadIcs}
      </Button>
      {calendarLinks(meeting, origin).map((link) => (
        <OutLink
          key={link.key}
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={strings.meetings.newTab(link.name)}
        >
          {link.name}
        </OutLink>
      ))}
    </Actions>
  )
}
