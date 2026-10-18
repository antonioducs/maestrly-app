import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowDown,
  ArrowLeft,
  ClipboardList,
  Clock,
  CornerDownRight,
  FileText,
  Film,
  Folder,
  GitBranch,
  Image as ImageIcon,
  Info,
  Loader2,
  Pin,
  Repeat,
  Square,
  Trash2,
} from 'lucide-react'
import type { FleetBot, FleetRoutineRun } from '@maestrly/bot-fleet-protocol'
import { ChatComposer } from '@/components/chat/ChatComposer'
import { GenUiContext, type GenUiHost } from '@/genui/context'
import { useAgentActivityMode } from '@/lib/agent-activity-preference'
import { fleetActivitySegments, type FleetActivitySegment } from '@/lib/agent-activity'
import { useChatOwnerWindow } from '@/lib/chat-window-context'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import { fleetImageCache } from '@/lib/fleet/image-cache'
import { latestTodoItemId, visibleTranscriptItems } from '@/lib/fleet/forms'
import { runDuration, runExpiresInDays, runState, runTitle, runWorking, type RunState } from '@/lib/fleet/runs'
import { emptyTranscript, runTranscriptKey } from '@/lib/fleet/state'
import { transcriptSegmentKey } from '@/lib/fleet/transcript-search'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { cn } from '@/lib/utils'
import { BotAgentActivity, TranscriptRow } from './BotConversation'
import { BotTranscriptImages, FleetTranscriptRunContext } from './BotTranscriptImages'

const pill: Record<RunState, string> = {
  running: 'border-sky-400/30 bg-sky-400/10 text-sky-300',
  queued: 'border-sky-400/30 bg-sky-400/10 text-sky-300',
  ok: 'border-emerald-400/30 bg-emerald-400/[0.07] text-emerald-300',
  quiet: 'border-border-strong text-muted-foreground',
  failed: 'border-red-400/30 bg-red-400/[0.07] text-red-300',
  cancelled: 'border-border-strong text-muted-foreground',
  deleted: 'border-border-strong text-muted-foreground',
  unknown: 'border-border-strong text-muted-foreground',
}

/** A run's report, as its history keeps it: what it did, what is pending and notes for the next run. */
function RunReport({ run }: { run: FleetRoutineRun }) {
  const { t } = useTranslation('fleet')
  if (!run.report) return null
  const rows: Array<[string, string]> = [
    [t('runs.report.did'), run.report.summary],
    ...(run.report.pending ? ([[t('runs.report.pending'), run.report.pending]] as Array<[string, string]>) : []),
    ...(run.report.notes ? ([[t('runs.report.notes'), run.report.notes]] as Array<[string, string]>) : []),
  ]
  return (
    <section className="rounded-xl border border-border bg-white/[0.02] px-4 py-3 text-[13px]">
      <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <ClipboardList aria-hidden="true" className="size-3.5" />
        {t('runs.report.title')}
        <span className="ml-auto font-normal">{t('runs.report.next')}</span>
      </h3>
      <dl className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-1.5">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-foreground/85 [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

/** What stays of a run whose conversation was deleted: when, its report, and its files in the bot's folder. */
function DeletedRun({ bot, run }: { bot: FleetBot; run: FleetRoutineRun }) {
  const { t, i18n } = useTranslation('fleet')
  const when = run.conversationDeletedAt
    ? new Date(run.conversationDeletedAt).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })
    : ''
  const files = run.kept?.files ?? []
  return (
    <>
      <div className="flex gap-3 rounded-xl border border-dashed border-border-strong p-4 text-[13px] text-foreground/85">
        <Trash2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div>
          <p>{t('runs.tomb.deleted', { when })}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('runs.tomb.body', { name: bot.name })}</p>
        </div>
      </div>
      <RunReport run={run} />
      <section className="rounded-xl border border-border px-4 py-3 text-[13px]">
        <h3 className="mb-2.5 flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
          <Folder aria-hidden="true" className="size-3.5" />
          {run.kept?.folder ? t('runs.tomb.folder', { name: bot.name }) : t('runs.tomb.shared', { name: bot.name })}
          {run.kept?.folder && <code className="text-foreground/80">{run.kept.folder}/</code>}
        </h3>
        {files.length ? (
          <ul className="flex flex-wrap gap-2">
            {files.map((file) => {
              const Icon = file.kind === 'image' ? ImageIcon : file.kind === 'video' ? Film : FileText
              return (
                <li
                  key={file.name}
                  className="inline-flex items-center gap-2 rounded-lg border border-border bg-white/[0.02] px-2.5 py-1.5 text-xs"
                >
                  <Icon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                  {file.name}
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">{t('runs.tomb.noFiles')}</p>
        )}
      </section>
    </>
  )
}

/**
 * One routine run's own conversation, as the bot's is: everything the run did (tools, images, videos and files), its
 * report, and a composer to ask the bot for changes there once the run ends. A deleted run shows what was kept of it.
 */
export function RoutineRunConversation({
  bot,
  fleet,
  run,
  narrow,
  visible,
  onBack,
  onOpenBot,
  onOpenScreen,
  onCite,
  onDelete,
}: {
  bot: FleetBot
  fleet: FleetController
  run: FleetRoutineRun
  /** One column at a time: the header offers the way back to the list. */
  narrow: boolean
  visible: boolean
  onBack: () => void
  onOpenBot: (id: string) => void
  onOpenScreen: () => void
  onCite: () => void
  onDelete: () => void
}) {
  const { t, i18n } = useTranslation('fleet')
  const state = runState(run, bot)
  const working = runWorking(state)
  const own = run.conversation === 'own'
  const key = runTranscriptKey(bot.id, run.id)
  const transcript = fleet.state.runTranscripts[key] ?? emptyTranscript
  const { ensureRunTranscript, loadRunTranscript } = fleet
  useEffect(() => {
    if (own) ensureRunTranscript(bot.id, run.id)
  }, [bot.id, ensureRunTranscript, own, run.id])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  useEffect(() => {
    setDraft('')
    setError(null)
  }, [run.id])

  // The transcript follows its end while the owner reads there, as the bot's conversation does.
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
  useEffect(() => {
    atBottomRef.current = true
    setAtBottom(true)
  }, [run.id])
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
    () =>
      compact
        ? fleetActivitySegments(items, { working: state === 'running' })
        : items.map((item) => ({ kind: 'item', item })),
    [compact, items, state]
  )
  const latestTodoId = latestTodoItemId(items)
  const host = useMemo<GenUiHost>(() => ({ live: state === 'running', send: undefined }), [state])
  const removeQueued = useCallback(
    async (inputId: string) => {
      await window.api.fleetRemoveQueuedMessage(bot.id, inputId)
      await loadRunTranscript(bot.id, run.id)
    },
    [bot.id, loadRunTranscript, run.id]
  )

  const send = async ({ text }: { text: string }) => {
    const value = text.trim()
    if (!value || busy || working) return
    setBusy(true)
    setError(null)
    try {
      await window.api.fleetSendRunMessage(bot.id, run.id, value)
      setDraft('')
      atBottomRef.current = true
      await loadRunTranscript(bot.id, run.id).catch(() => {})
    } catch (cause) {
      setError(
        String(cause).includes('FLEET_RUN_CONFLICT')
          ? t('runs.delete.conflict')
          : String(cause).includes('FLEET_RUNS_UNSUPPORTED')
            ? t('runs.unsupported')
            : fleetErrorMessage(cause)
      )
    } finally {
      setBusy(false)
    }
  }
  const pin = async () => {
    setError(null)
    try {
      const updated = await window.api.fleetPinRun(bot.id, run.id, !run.pinned)
      fleet.dispatch({ type: 'runs.upsert', botId: bot.id, run: updated })
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    }
  }

  const title = runTitle(run, t('transcript.routine.label'))
  const at = new Date(run.deliveredAt)
  const when = at.toLocaleString(i18n.language, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  const duration = runDuration(run)
  const durationText =
    duration === null
      ? null
      : duration < 60
        ? t('runs.durationSeconds', { count: duration })
        : t('runs.durationMinutes', {
            minutes: Math.floor(duration / 60),
            seconds: String(duration % 60).padStart(2, '0'),
          })
  const meta = [
    when,
    t(run.trigger === 'manual' ? 'runs.detail.manual' : 'runs.detail.scheduled'),
    working ? null : durationText,
  ]
    .filter(Boolean)
    .join(' · ')
  const expires = runExpiresInDays(run, Date.now())
  const retention = run.pinned
    ? t('runs.detail.kept')
    : working
      ? t('runs.detail.startsWhenDone')
      : expires === null
        ? t('runs.detail.never')
        : expires === 0
          ? t('runs.detail.expiresToday')
          : t('runs.detail.expires', { count: expires })
  const action =
    'inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] text-muted-foreground hover:bg-white/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40'

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-14 shrink-0 items-center gap-2.5 border-b border-border py-2 pl-3 pr-2.5">
        {narrow && (
          <button
            type="button"
            onClick={onBack}
            aria-label={t('runs.detail.back')}
            title={t('runs.detail.back')}
            className={action}
          >
            <ArrowLeft className="size-4" />
          </button>
        )}
        <span
          aria-hidden="true"
          className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-sky-400/10 text-sky-300"
        >
          <Repeat className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            <span className="truncate">{title}</span>
            <span
              className={cn(
                'inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] font-medium',
                pill[state]
              )}
            >
              {state === 'running' && (
                <Loader2 aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" />
              )}
              {t(`runs.state.${state}`)}
            </span>
          </h2>
          <p className="truncate text-[11.5px] text-muted-foreground">{meta}</p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {state === 'running' ? (
            <button
              type="button"
              className={cn(action, 'border border-border-strong text-foreground')}
              onClick={() =>
                void window.api.fleetBotAction(bot.id, 'cancel').catch((cause) => setError(fleetErrorMessage(cause)))
              }
            >
              <Square aria-hidden="true" className="size-3" />
              {t('runs.actions.stop')}
            </button>
          ) : (
            <>
              {run.conversation !== 'primary' && (
                <button
                  type="button"
                  className={action}
                  title={t('runs.actions.citeTitle', { name: bot.name })}
                  onClick={onCite}
                >
                  <CornerDownRight aria-hidden="true" className="size-3.5" />
                  <span className="hidden @lg:inline">{t('runs.actions.cite')}</span>
                </button>
              )}
              {own && (
                <>
                  <button
                    type="button"
                    className={cn(action, run.pinned && 'text-sky-300')}
                    aria-pressed={run.pinned}
                    title={t('runs.actions.pinTitle')}
                    onClick={() => void pin()}
                  >
                    <Pin aria-hidden="true" className="size-3.5" />
                    <span className="hidden @lg:inline">
                      {t(run.pinned ? 'runs.actions.pinned' : 'runs.actions.pin')}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={cn(action, 'hover:text-red-300')}
                    aria-label={t('runs.actions.delete')}
                    title={t('runs.actions.delete')}
                    disabled={working}
                    onClick={onDelete}
                  >
                    <Trash2 aria-hidden="true" className="size-3.5" />
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
      {own && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-sky-400/[0.025] px-4 py-1.5 text-[11.5px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <GitBranch aria-hidden="true" className="size-3" />
            {t('runs.detail.separate')}
          </span>
          <span
            className={cn(
              'inline-flex items-center gap-1.5',
              !run.pinned && expires !== null && expires <= 7 && 'text-amber-300'
            )}
          >
            {run.pinned ? (
              <Pin aria-hidden="true" className="size-3" />
            ) : (
              <Clock aria-hidden="true" className="size-3" />
            )}
            {retention}
          </span>
        </div>
      )}
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
            {run.conversation === 'deleted' ? (
              <DeletedRun bot={bot} run={run} />
            ) : run.conversation === 'primary' ? (
              <>
                <p className="rounded-xl border border-dashed border-border-strong p-4 text-[13px] text-muted-foreground">
                  {t('runs.detail.legacy', { name: bot.name })}
                </p>
                <RunReport run={run} />
              </>
            ) : (
              <FleetTranscriptRunContext.Provider value={run.id}>
                {transcript.error && (
                  <div role="alert" className="text-center text-xs text-destructive">
                    {t('runs.detail.transcriptFailed')}{' '}
                    <button
                      type="button"
                      className="ml-2 text-primary underline"
                      onClick={() => void loadRunTranscript(bot.id, run.id).catch(() => {})}
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
                      void loadRunTranscript(bot.id, run.id, transcript.before).catch((cause) =>
                        setError(fleetErrorMessage(cause))
                      )
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
                            imageCache={fleetImageCache}
                            onShowOnComputer={onOpenScreen}
                          />
                        ) : segment.kind === 'images' ? (
                          <BotTranscriptImages
                            botId={bot.id}
                            images={segment.item.images}
                            cache={fleetImageCache}
                            size="large"
                          />
                        ) : (
                          <TranscriptRow
                            bot={bot}
                            item={segment.item}
                            fleet={fleet}
                            onOpenBot={onOpenBot}
                            onOpenScreen={onOpenScreen}
                            imageCache={fleetImageCache}
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
                {!working && <RunReport run={run} />}
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
      {own && (
        <div className="border-t border-border px-4 py-3">
          <div className="mx-auto max-w-3xl">
            <ChatComposer
              value={draft}
              onChange={setDraft}
              streaming={false}
              disabled={working || busy}
              disabledPlaceholder={working ? t('runs.composer.working') : undefined}
              placeholder={t('runs.composer.placeholder')}
              onSend={(payload) => void send(payload)}
              onStop={() => {}}
            />
            <p className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
              <Info aria-hidden="true" className="size-3 shrink-0" />
              {t('runs.composer.hint', { name: bot.name })}
            </p>
            {error && (
              <p role="alert" className="mt-2 text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
        </div>
      )}
      {!own && error && (
        <p role="alert" className="px-4 pb-3 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
