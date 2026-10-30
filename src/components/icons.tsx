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
