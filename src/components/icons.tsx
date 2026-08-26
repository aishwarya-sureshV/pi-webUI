/** Minimal inline icons matching the deepseek composer glyph set. */

export function IconPlus({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden>
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
    </svg>
  )
}

export function IconUpload({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 10.5V2.8M4.9 5.9 8 2.8l3.1 3.1" />
      <path d="M3 9.5v2.2A1.3 1.3 0 0 0 4.3 13h7.4a1.3 1.3 0 0 0 1.3-1.3V9.5" />
    </svg>
  )
}

export function IconCommand({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5.4 3.5H4.2a2 2 0 0 0 0 4h7.6a2 2 0 1 1 0 4h-1.2" />
      <path d="m4.2 9.5-2 2 2 2M11.8 1.5l2 2-2 2" />
    </svg>
  )
}

export function IconFile({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round">
      <path d="M4 1.8h5l3 3v9.4H4z" />
      <path d="M9 1.8v3h3" />
    </svg>
  )
}

export function IconFolder({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6a1.5 1.5 0 0 1 1.06.44l.84.84a1.5 1.5 0 0 0 1.06.44h3.44A1.5 1.5 0 0 1 14 6.22v5.28a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z" />
    </svg>
  )
}

export function IconShield({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M8 1.8 13 3.6v4.1c0 3-2.1 5.4-5 6.5-2.9-1.1-5-3.5-5-6.5V3.6L8 1.8Z" />
      <path d="M8 5.5v3" strokeLinecap="round" />
    </svg>
  )
}

export function IconCube({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M8 1.5 14 4.8v6.4L8 14.5 2 11.2V4.8L8 1.5Z" />
      <path d="M8 8 14 4.8M8 8v6.5M8 8 2 4.8" />
    </svg>
  )
}

export function IconChevronDown({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 14 14" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="m3.5 5.5 3.5 3.5 3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** deepseek fish logo approximation (used in the hero headline). */
export function FishLogo({ size = 34 }: { size?: number }) {
  return (
    <svg viewBox="0 0 34 34" width={size} height={size} aria-hidden fill="currentColor">
      <path d="M24.5 6c-5.6.3-10.3 3.3-13 7.5-1 1.6-1.8 3-3.4 3.6-1.3.5-2.9.2-4.1 1-1 .7-1.3 2.1-.8 3.2.7-.9 1.9-1.3 2.9-1 1.4.4 2.3 1.8 2.7 3.2.4 1.4.4 3 1.2 4.2.7 1 2 1.5 3 1.1-.4-1-.3-2.2.2-3.1.7-1.2 2-1.8 3.2-2.3 3.2-1.2 6.2-3.5 7.9-6.7 1.7-3.2 2-7 .7-10.2-.2-.5-.4-.9-.5-.5Z" />
      <circle cx="22.8" cy="12.4" r="1.4" fill="var(--dsw-alias-bg-base)" />
    </svg>
  )
}

export function IconArrowUp({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function IconStop({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden>
      <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" />
    </svg>
  )
}

export function IconPanel({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="1.8" y="2.2" width="12.4" height="11.6" rx="2" />
      <path d="M5.5 2.5v11" />
    </svg>
  )
}

export function IconColumns({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.25">
      <rect x="1.8" y="2.2" width="12.4" height="11.6" rx="2" />
      <path d="M8 2.5v11" />
    </svg>
  )
}

export function IconNewChat({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13.4 7.5v4.1a1.8 1.8 0 0 1-1.8 1.8H4.4a1.8 1.8 0 0 1-1.8-1.8V4.4a1.8 1.8 0 0 1 1.8-1.8h4.1" />
      <path d="M10.2 2.8h3v3M8.8 7.2l4.4-4.4" />
    </svg>
  )
}

export function IconSun({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round">
      <circle cx="8" cy="8" r="2.6" />
      <path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M12.6 3.4l-.9.9M4.3 11.7l-.9.9" />
    </svg>
  )
}

export function IconMoon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.9 10.3A5.6 5.6 0 0 1 5.7 3.1a5.6 5.6 0 1 0 7.2 7.2Z" />
    </svg>
  )
}

export function IconDots({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="currentColor">
      <circle cx="3" cy="8" r="1.1" />
      <circle cx="8" cy="8" r="1.1" />
      <circle cx="13" cy="8" r="1.1" />
    </svg>
  )
}

export function IconArchive({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.2 4.2h11.6v8.2a1.2 1.2 0 0 1-1.2 1.2H3.4a1.2 1.2 0 0 1-1.2-1.2V4.2Z" />
      <path d="M1.6 2.3h12.8v2H1.6zM6 7.2h4" />
    </svg>
  )
}

export function IconRestore({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.2 5.3A5.3 5.3 0 1 1 2.9 10" />
      <path d="M3.2 2.2v3.1H.2M8 4.8v3.5l2.4 1.4" />
    </svg>
  )
}

export function IconTrash({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 4.2h11M6 1.9h4l.7 2.3H5.3L6 1.9ZM4.2 4.2l.6 9.2h6.4l.6-9.2M6.7 7v3.7M9.3 7v3.7" />
    </svg>
  )
}

export function IconSearch({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round">
      <circle cx="6.8" cy="6.8" r="4.5" />
      <path d="m10.2 10.2 3.4 3.4" />
    </svg>
  )
}

export function IconFolderPlus({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 5A1.5 1.5 0 0 1 3.5 3.5h2.3l1.3 1.4h5.4A1.5 1.5 0 0 1 14 6.4v5.1a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5V5Z" />
      <path d="M10.5 7v4M8.5 9h4" />
    </svg>
  )
}

export function IconDownload({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2.2v7.4M5.2 7.2 8 10l2.8-2.8" />
      <path d="M3 11.2v1.4A1.4 1.4 0 0 0 4.4 14h7.2a1.4 1.4 0 0 0 1.4-1.4v-1.4" />
    </svg>
  )
}

export function IconCopy({ size = 15 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round">
      <rect x="5.2" y="5.2" width="8.1" height="8.1" rx="1.4" />
      <path d="M10.8 5.2V3.9a1.3 1.3 0 0 0-1.3-1.3H3.9a1.3 1.3 0 0 0-1.3 1.3v5.6a1.3 1.3 0 0 0 1.3 1.3h1.3" />
    </svg>
  )
}

export function IconCheck({ size = 15 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3 8.2 3.1 3.1L13 4.7" />
    </svg>
  )
}

export function IconFork({ size = 15 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4" cy="3.2" r="1.5" />
      <circle cx="12" cy="3.2" r="1.5" />
      <circle cx="8" cy="12.8" r="1.5" />
      <path d="M4 4.7v1.1A3.2 3.2 0 0 0 7.2 9H8m4-4.3v1.1A3.2 3.2 0 0 1 8.8 9H8v2.3" />
    </svg>
  )
}

export function IconExtension({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6.2 6.2V3.1M9.8 6.2V3.1M4.8 6.2h6.4v2.2A3.2 3.2 0 0 1 8 11.6a3.2 3.2 0 0 1-3.2-3.2V6.2Z" />
      <path d="M8 11.6v2.2" />
    </svg>
  )
}

export function IconTerminal({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.7" y="2.2" width="12.6" height="11.6" rx="2" />
      <path d="m4.2 5.2 2.3 2.1-2.3 2.1M8.2 10h3.2" />
    </svg>
  )
}

export function IconSettings({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6.8 1.8.4 1.4c.5-.1 1.1-.1 1.6 0l.4-1.4 1.7.7-.7 1.3c.4.3.8.7 1.1 1.1l1.3-.7.7 1.7-1.4.4c.1.5.1 1.1 0 1.6l1.4.4-.7 1.7-1.3-.7c-.3.4-.7.8-1.1 1.1l.7 1.3-1.7.7-.4-1.4c-.5.1-1.1.1-1.6 0l-.4 1.4-1.7-.7.7-1.3c-.4-.3-.8-.7-1.1-1.1l-1.3.7-.7-1.7 1.4-.4a4.5 4.5 0 0 1 0-1.6l-1.4-.4.7-1.7 1.3.7c.3-.4.7-.8 1.1-1.1l-.7-1.3 1.7-.7Z" />
      <circle cx="8" cy="7.1" r="1.8" />
    </svg>
  )
}

export function IconRefresh({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 5.8A5.4 5.4 0 0 0 3.1 5L2 6.3M3 10.2A5.4 5.4 0 0 0 12.9 11l1.1-1.3" />
      <path d="M2 3.2v3.1h3.1M14 12.8V9.7h-3.1" />
    </svg>
  )
}
