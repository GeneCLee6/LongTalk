// Line icons, 24×24, drawn in currentColor so the parent's colour token applies. Decorative:
// the button around them carries the accessible name.

const common = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
}

export function MicIcon() {
  return (
    <svg {...common}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  )
}

export function MicOffIcon() {
  return (
    <svg {...common}>
      <path d="M15 9.5V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.9 2.3" />
      <path d="M5 11a7 7 0 0 0 11.5 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18" />
    </svg>
  )
}

export function CamIcon() {
  return (
    <svg {...common}>
      <rect x="3" y="6" width="13" height="12" rx="2" />
      <path d="m16 10 5-3v10l-5-3z" />
    </svg>
  )
}

export function CamOffIcon() {
  return (
    <svg {...common}>
      <path d="M10 6h4a2 2 0 0 1 2 2v4m0 4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2" />
      <path d="m16 10 5-3v10l-3-1.8M3 3l18 18" />
    </svg>
  )
}

export function ChevronUpIcon() {
  return (
    <svg {...common}>
      <path d="m6 15 6-6 6 6" />
    </svg>
  )
}

/** Sound bars: the nameplate's speaking mark, so speaking is not shown by colour alone */
export function SpeakingIcon() {
  return (
    <svg {...common}>
      <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
    </svg>
  )
}

/** A circling arrow: reconnecting */
export function ReconnectIcon() {
  return (
    <svg {...common}>
      <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  )
}

/** A screen with an arrow out of it: share the screen */
export function ScreenShareIcon() {
  return (
    <svg {...common}>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4M12 13V8m-3 3 3-3 3 3" />
    </svg>
  )
}

/** A speech bubble: chat */
export function ChatIcon() {
  return (
    <svg {...common}>
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.2-4.4A8 8 0 1 1 21 12z" />
    </svg>
  )
}

/** Two people: participants */
export function PeopleIcon() {
  return (
    <svg {...common}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14a6.5 6.5 0 0 1 3.5 6" />
    </svg>
  )
}

/** Three dots: more */
export function MoreIcon() {
  return (
    <svg {...common}>
      <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth={3} />
    </svg>
  )
}

/** A door with an arrow out: leave */
export function LeaveIcon() {
  return (
    <svg {...common}>
      <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M9 16l-4-4 4-4M5 12h11" />
    </svg>
  )
}

/** Two chain links: the room link */
export function LinkIcon() {
  return (
    <svg {...common}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </svg>
  )
}
