import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, Loader2 } from 'lucide-react'
import type { FleetBot } from '@maestrly/bot-fleet-protocol'
import { GenUiContext, type GenUiHost } from '@/genui/context'
import { useAgentActivityMode } from '@/lib/agent-activity-preference'
import { fleetActivitySegments, type FleetActivitySegment } from '@/lib/agent-activity'
import { useChatOwnerWindow } from '@/lib/chat-window-context'
import { fleetImageCache } from '@/lib/fleet/image-cache'
import { latestTodoItemId, visibleTranscriptItems } from '@/lib/fleet/forms'
import type { TranscriptState } from '@/lib/fleet/state'
import { transcriptSegmentKey } from '@/lib/fleet/transcript-search'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { BotAgentActivity, TranscriptRow } from './BotConversation'
import { BotTranscriptImages, FleetTranscriptRunContext } from './BotTranscriptImages'

/**
 * The transcript of one of a bot's side conversations (a routine run's, or a thread's with another bot), as the bot's
 * own conversation shows it: it follows its end while the owner reads there, and loads older pages on request.
 * `placeholder` stands for a transcript there is no more of; `footer` follows the items.
 */
export function LaneTranscript({
  bot,
  fleet,
  laneId,
  transcript,
  live,
  visible,
  failedText,
  placeholder,
  footer,
  onLoad,
  onOpenBot,
  onOpenScreen,
  onError,
  follow = 0,
}: {
  bot: FleetBot
  fleet: FleetController
  /** The run's or the thread's id: its images are read from its conversation. */
  laneId: string
  transcript: TranscriptState
  /** Whether a turn works in it now. */
  live: boolean
  visible: boolean
  failedText: string
  placeholder?: ReactNode
  footer?: ReactNode
  /** Loads its newest page, or with `before` the one before it. */
  onLoad: (before?: string | null) => Promise<void>
  onOpenBot: (id: string) => void
  onOpenScreen: () => void
  onError: (cause: unknown) => void
  /** Changes when the owner sends a message: the transcript follows its end again. */
  follow?: number
}) {
  const serverId = fleet.serverId
  const { t } = useTranslation('fleet')
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const oldHeightRef = useRef<number | null>(null)
  const ownerWindow = useChatOwnerWindow()
  useLayoutEffect(() => {
    const node = scrollRef.current
    if (!node || !visible) return
    if (oldHeightRef.current !== null) {
      node.scrollTop = node.scrollHeight - oldHeightRef.current
      oldHeightRef.current = null
    } else if (atBottomRef.current) node.scrollTop = node.scrollHeight
  }, [transcript.items, visible])
  // Another lane starts at its end; so does this one after the owner writes in it.
  useEffect(() => {
    atBottomRef.current = true
    setAtBottom(true)
  }, [laneId, follow])
  useEffect(() => {
    const node = scrollRef.current
    const content = contentRef.current
    if (!node || !content) return
    const observer = new ResizeObserver(() => {
      if (atBottomRef.current && node.clientHeight > 0) node.scrollTop = node.scrollHeight
    })
    observer.observe(node)
    observer.observe(content)
    return () => observer.disconnect()
  }, [])
  const holdReadingPosition = useCallback(() => {
    atBottomRef.current = false
    ownerWindow.requestAnimationFrame(() => {
      const node = scrollRef.current
      if (!node) return
      atBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
      setAtBottom(atBottomRef.current)
    })
  }, [ownerWindow])

  const compact = useAgentActivityMode() === 'compact'
  const items = useMemo(() => visibleTranscriptItems(transcript.items), [transcript.items])
  const segments = useMemo<FleetActivitySegment[]>(
    () => (compact ? fleetActivitySegments(items, { working: live }) : items.map((item) => ({ kind: 'item', item }))),
    [compact, items, live]
  )
  const latestTodoId = latestTodoItemId(items)
  const host = useMemo<GenUiHost>(() => ({ live, send: undefined }), [live])
  const removeQueued = useCallback(
    async (inputId: string) => {
      await window.api.fleetRemoveQueuedMessage(serverId, bot.id, inputId)
      await onLoad()
    },
    [bot.id, onLoad]
  )

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const node = event.currentTarget
          if (node.clientHeight === 0) return
          atBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
          setAtBottom(atBottomRef.current)
        }}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden"
      >
        <div ref={contentRef} className="mx-auto flex min-w-0 max-w-3xl flex-col gap-4 px-6 py-6">
          {placeholder ?? (
            <FleetTranscriptRunContext.Provider value={laneId}>
              {transcript.error && (
                <div role="alert" className="text-center text-xs text-destructive">
                  {failedText}{' '}
                  <button
                    type="button"
                    className="ml-2 text-primary underline"
                    onClick={() => void onLoad().catch(() => {})}
                  >
                    {t('runs.retry')}
                  </button>
                </div>
              )}
              {transcript.before && (
                <button
                  type="button"
                  disabled={transcript.loading}
                  className="self-center rounded-md border border-border px-3 py-1.5 text-xs"
                  onClick={() => {
                    oldHeightRef.current = scrollRef.current?.scrollHeight ?? null
                    void onLoad(transcript.before).catch(onError)
                  }}
                >
                  {t('transcript.loadOlder')}
                </button>
              )}
              {!transcript.loaded && transcript.loading && (
                <Loader2
                  aria-hidden="true"
                  className="mx-auto size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
                />
              )}
              <GenUiContext.Provider value={host}>
                {segments.map((segment) => {
                  const segmentKey = transcriptSegmentKey(segment)
                  return (
                    <div key={segmentKey} className="contents">
                      {segment.kind === 'activity' ? (
                        <BotAgentActivity
                          bot={bot}
                          segment={segment}
                          imageCache={fleetImageCache(serverId)}
                          onShowOnComputer={onOpenScreen}
                        />
                      ) : segment.kind === 'images' ? (
                        <BotTranscriptImages
                          botId={bot.id}
                          images={segment.item.images}
                          cache={fleetImageCache(serverId)}
                          size="large"
                        />
                      ) : (
                        <TranscriptRow
                          bot={bot}
                          item={segment.item}
                          fleet={fleet}
                          onOpenBot={onOpenBot}
                          onOpenScreen={onOpenScreen}
                          imageCache={fleetImageCache(serverId)}
                          latestTodoId={latestTodoId}
                          routineSchedule={null}
                          repeatedRoutine={false}
                          onExpand={holdReadingPosition}
                          removeQueuedMessage={removeQueued}
                        />
                      )}
                    </div>
                  )
                })}
              </GenUiContext.Provider>
              {footer}
            </FleetTranscriptRunContext.Provider>
          )}
        </div>
      </div>
      {!atBottom && segments.length > 0 && (
        <button
          type="button"
          onClick={() => {
            const node = scrollRef.current
            if (!node) return
            atBottomRef.current = true
            setAtBottom(true)
            node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' })
          }}
          title={t('chat:messages.goToBottom')}
          aria-label={t('chat:messages.goToBottom')}
          className="absolute bottom-3 left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-white/[0.1] bg-[#1a1a1f] text-foreground shadow-lg transition hover:bg-[#26262d]"
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}
