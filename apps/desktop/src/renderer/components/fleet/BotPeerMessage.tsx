import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight } from 'lucide-react'
import { MarkdownViewer } from '@/components/MarkdownViewer'
import { useChatOwnerWindow } from '@/lib/chat-window-context'

/** A long message shows this much until the owner asks for the rest. */
const CLAMP_PX = 320
/** Folding away less than this would hide too little to be worth a click. */
const CLAMP_SLACK_PX = 120
const HEADINGS = 'h1, h2, h3, h4, h5, h6'
const fade = 'linear-gradient(to bottom, #000 calc(100% - 72px), transparent)'
const clampStyle: CSSProperties = { maxHeight: CLAMP_PX, overflow: 'hidden', maskImage: fade, WebkitMaskImage: fade }

interface PeerBot {
  name: string
  tint: string
}

function BotMark({ bot }: { bot: PeerBot }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-[22px] shrink-0 items-center justify-center rounded-md text-[10.5px] font-semibold text-white"
      style={{ background: bot.tint }}
    >
      {bot.name.charAt(0).toUpperCase()}
    </span>
  )
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/**
 * A message between two bots, either way: who wrote to whom, then the message as Markdown. A long one is folded, with
 * its sections one click away.
 */
export function BotPeerMessage({
  from,
  to,
  at,
  text,
  meta,
  footer,
  onOpenPeer,
  onExpand,
  searchQuery,
  currentSearchMatch,
}: {
  from: PeerBot
  to: PeerBot
  at: string
  text: string
  /** Shown after the time, like a queued state. */
  meta?: ReactNode
  /** Shown at the end, like the delivery state or the recalled memories. */
  footer?: ReactNode
  onOpenPeer?: () => void
  /** The card grows where the owner reads: the transcript should stay there. */
  onExpand?: () => void
  searchQuery?: string
  currentSearchMatch?: boolean
}) {
  const { t } = useTranslation('fleet')
  const ownerWindow = useChatOwnerWindow()
  const contentRef = useRef<HTMLDivElement>(null)
  const bodyId = useId()
  const [long, setLong] = useState(false)
  const [headings, setHeadings] = useState<string[]>([])
  const [expanded, setExpanded] = useState(false)
  useLayoutEffect(() => {
    const node = contentRef.current
    if (!node) return
    // The inner content keeps its natural height under the fold; Markdown, Mermaid and images grow it later.
    const measure = () => {
      setLong(node.scrollHeight > CLAMP_PX + CLAMP_SLACK_PX)
      const next = Array.from(node.querySelectorAll(HEADINGS), (heading) => heading.textContent?.trim() ?? '')
      setHeadings((current) => (sameList(current, next) ? current : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [text])
  // A search match anywhere in the message shows all of it.
  const folded = long && !expanded && !searchQuery
  const expand = () => {
    if (folded) onExpand?.()
    setExpanded(true)
  }
  const jumpTo = (index: number) => {
    expand()
    ownerWindow.requestAnimationFrame(() =>
      contentRef.current
        ?.querySelectorAll<HTMLElement>(HEADINGS)
        [index]?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    )
  }
  return (
    <article
      aria-label={t('transcript.peer.label', { from: from.name, to: to.name })}
      className="overflow-hidden rounded-xl border border-border bg-white/[0.025]"
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3.5 py-2.5">
        <span className="flex min-w-0 items-center gap-2 text-[13px]">
          <BotMark bot={from} />
          <span className="truncate font-semibold">{from.name}</span>
          <ArrowRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          <BotMark bot={to} />
          <span className="truncate font-semibold">{to.name}</span>
        </span>
        <span className="text-xs text-muted-foreground">
          · {at}
          {meta && <> · {meta}</>}
        </span>
        {onOpenPeer && (
          <button
            type="button"
            onClick={onOpenPeer}
            className="ml-auto rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-white/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('transcript.openPeer')}
          </button>
        )}
      </header>
      {long && headings.length >= 2 && (
        <nav aria-label={t('transcript.peer.sections')} className="flex flex-wrap gap-1.5 px-4 pt-3">
          {headings.map((heading, index) => (
            <button
              // Headings may repeat; their order does not change while the message is shown.
              key={index}
              type="button"
              onClick={() => jumpTo(index)}
              className="max-w-[16rem] truncate rounded-full border border-border-strong px-2.5 text-xs leading-[22px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {heading}
            </button>
          ))}
        </nav>
      )}
      <div id={bodyId} style={folded ? clampStyle : undefined} className="px-4 py-3 text-sm [overflow-wrap:anywhere]">
        <div ref={contentRef}>
          <MarkdownViewer markdown={text} searchQuery={searchQuery} currentSearchMatch={currentSearchMatch} />
        </div>
      </div>
      {(long || footer) && (
        <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 pb-2.5 text-xs text-muted-foreground">
          {long && !searchQuery && (
            <button
              type="button"
              aria-expanded={!folded}
              aria-controls={bodyId}
              onClick={() => (folded ? expand() : setExpanded(false))}
              className="rounded-md border border-border-strong px-2 py-0.5 text-foreground/90 hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t(folded ? 'transcript.peer.showAll' : 'transcript.peer.showLess')}
            </button>
          )}
          {footer}
        </footer>
      )}
    </article>
  )
}
