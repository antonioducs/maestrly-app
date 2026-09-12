import type { ReactNode } from 'react'

/**
 * Empty state built from the two brand arcs. The cue dot rides the arc on hover (CSS `offset-path`),
 * disabled under reduced motion. Colours come from tokens so it follows the theme.
 */
export function EmptyState({
  title,
  children,
  action,
  heading = 'h3',
}: {
  title: string
  children?: ReactNode
  action?: ReactNode
  heading?: 'h2' | 'h3'
}) {
  const Heading = heading
  return (
    <div className="empty">
      <svg className="empty-art" viewBox="0 0 160 96" aria-hidden="true" focusable="false">
        <path d="M 12 84 H 148" className="empty-art-base" />
        <path d="M 34 70 A 46 46 0 0 1 126 70" className="empty-art-arc empty-art-arc-inner" />
        <path d="M 24 70 A 56 56 0 0 1 136 70" className="empty-art-arc" />
        <circle r="4" className="empty-art-dot" />
      </svg>
      <Heading>{title}</Heading>
      {children}
      {action}
    </div>
  )
}
