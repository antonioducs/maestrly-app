import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Wrench, X } from 'lucide-react'
import type { FleetBot, FleetTranscriptItem } from '@maestrly/bot-fleet-protocol'
import { MarkdownViewer } from '@/components/MarkdownViewer'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { ownsTakeover, takeoverBlocksResume } from '@/lib/fleet/selectors'
import { startBot } from '@/lib/fleet/environments'
import { isComputerTool } from '@/lib/fleet/format'
import { latestTodoItemId, visibleTranscriptItems } from '@/lib/fleet/forms'
import { Button } from '@/components/ui/button'
import { TodoList } from '@/components/chat/TodoCard'
import { InteractionCard } from './InteractionCard'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import { fleetImageCache, type FleetImageCache } from '@/lib/fleet/image-cache'
import { BotComposer } from './BotComposer'
import { BotTranscriptImages } from './BotTranscriptImages'
import { BotTranscriptFiles } from './BotTranscriptFiles'
import { AgentActivity } from '@/components/chat/AgentActivity'
import { useAgentActivityMode } from '@/lib/agent-activity-preference'
import { ArtifactCard } from '../artifacts/ArtifactCard'
import { parseArtifactToolResult } from '../../../shared/artifacts'
import { baseToolName, fleetActivitySegments, type FleetActivitySegment } from '@/lib/agent-activity'

/** On a tool that works on the bot's computer: takes the owner there. */
function ShowOnComputer({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation('fleet')
  return (
    <button
      type="button"
      onClick={onClick}
      className="whitespace-nowrap rounded-md bg-popover px-2 py-0.5 text-xs text-foreground/80 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {t('computer.showOnComputer')}
    </button>
  )
}

function TranscriptRow({
  bot,
  item,
  fleet,
  onOpenBot,
  onOpenScreen,
  imageCache,
  latestTodoId,
}: {
  bot: FleetBot
  imageCache: FleetImageCache
  item: FleetTranscriptItem
  fleet: FleetController
  onOpenBot: (id: string) => void
  onOpenScreen: () => void
  latestTodoId: string | null
}) {
  const { t, i18n } = useTranslation('fleet')
  const at = new Date(item.at).toLocaleTimeString(i18n.language, {
    hour: '2-digit',
    minute: '2-digit',
  })
  if (item.kind === 'user') {
    if (item.source === 'peer')
      return (
        <div className="rounded-lg border border-dashed border-border p-3 text-sm">
          <div className="mb-1 text-xs text-muted-foreground">
            {t('transcript.peerWrote', {
              name: item.peer?.name ?? '',
              bot: bot.name,
            })}{' '}
            · {at}
          </div>
          {item.text}
          {item.memories.length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('conversation.recalled', { titles: item.memories.map((memory) => memory.title).join(', ') })}
            </p>
          )}
          {item.peer && fleet.state.snapshot.bots.some((peer) => peer.id === item.peer?.botId) && (
            <button
              type="button"
              className="ml-2 text-primary hover:underline"
              onClick={() => onOpenBot(item.peer!.botId)}
            >
              {t('transcript.openPeer')}
            </button>
          )}
        </div>
      )
    return (
      <div className="ml-auto max-w-[85%] rounded-xl border border-border-strong bg-surface-elevated px-4 py-3 text-sm">
        {item.source === 'routine' && (
          <span className="mb-2 block text-xs text-primary">
            {t('transcript.routine', {
              title: item.routine?.title ?? '',
              time: at,
            })}
          </span>
        )}
        <p className="whitespace-pre-wrap">{item.text}</p>
        {item.memories.length > 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            {t('conversation.recalled', { titles: item.memories.map((memory) => memory.title).join(', ') })}
          </p>
        )}
        <BotTranscriptImages botId={bot.id} images={item.images} cache={imageCache} />
        <BotTranscriptFiles botId={bot.id} files={item.files} />
        {item.attachmentError && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {t(item.attachmentError === 'pdf-unreadable' ? 'files.unreadablePdf' : 'files.invalidAttachment')}
          </p>
        )}
        <span className="mt-1 flex items-center justify-end gap-2 text-xs text-muted-foreground">
          {at}
          {item.queued && (
            <>
              {t(item.attachmentError ? 'files.notSent' : 'transcript.queued')}
              <button
                type="button"
                aria-label={t('transcript.removeQueued')}
                className="rounded p-0.5 hover:text-destructive"
                onClick={() =>
                  void window.api
                    .fleetRemoveQueuedMessage(bot.id, item.id.replace(/^input:/, ''))
                    .then(() => fleet.loadTranscript(bot.id))
                    .catch(() => {})
                }
              >
                <X className="size-3" />
              </button>
            </>
          )}
        </span>
      </div>
    )
  }
  if (item.kind === 'assistant')
    return (
      <div className="max-w-[90%] text-sm">
        <MarkdownViewer markdown={item.text} />
        {item.streaming && <span className="text-xs text-muted-foreground">{t('transcript.streaming')}</span>}
        <span className="mt-1 block text-xs text-muted-foreground">{at}</span>
      </div>
    )
  if (item.kind === 'reasoning')
    return (
      <div className="max-w-[90%] rounded-lg border border-white/[0.06] bg-white/[0.015] px-3 py-2 text-[13px] italic text-muted-foreground">
        <MarkdownViewer markdown={item.text} />
        {item.truncated && <p className="mt-2 text-xs not-italic">{t('chat:activity.truncated')}</p>}
      </div>
    )
  if (item.kind === 'compaction')
    return (
      <div className="my-1 flex min-w-0 max-w-full flex-col gap-2">
        <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
          <span className="h-px flex-1 bg-white/[0.1]" />
          {t('transcript.compaction.heading')}
          <span className="h-px flex-1 bg-white/[0.1]" />
        </div>
        <p className="text-center text-xs text-muted-foreground">{t(`transcript.compaction.${item.origin}`)}</p>
        {item.origin === 'runtime' ? (
          <p className="rounded-lg border border-white/[0.06] bg-white/[0.015] px-3 py-2 text-xs text-muted-foreground">
            {t('chat:messages.nativeContextCheckpoint')}
          </p>
        ) : item.summary ? (
          <details className="rounded-lg border border-white/[0.06] bg-white/[0.015] px-3 py-2">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              {t('chat:messages.previousContextSummary')}
            </summary>
            <div className="mt-2 text-sm text-muted-foreground">
              <MarkdownViewer markdown={item.summary} />
            </div>
            {item.truncated && (
              <p className="mt-2 text-xs text-muted-foreground">{t('transcript.compaction.truncated')}</p>
            )}
          </details>
        ) : null}
      </div>
    )
  // An instance that predates the checklist sends no todos; its todo_write keeps the generic row below.
  if (item.kind === 'tool' && item.name === 'todo_write' && item.todos)
    return item.id === latestTodoId ? <TodoList todos={item.todos} /> : null
  if (item.kind === 'tool' && item.files?.length) return <BotTranscriptFiles botId={bot.id} files={item.files} />
  if (item.kind === 'tool' && ['artifact_create', 'artifact_update'].includes(baseToolName(item.name))) {
    const result = parseArtifactToolResult(item.output ?? '')
    if (result)
      return (
        <ArtifactCard result={result} onOpen={() => window.api.artifacts.openExternal(result.id, result.version)} />
      )
  }
  if (item.kind === 'tool')
    return (
      <div className="group/row rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          {item.state === 'running' ? (
            <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
          ) : (
            <Wrench className="size-3" />
          )}
          <code className="text-foreground">{item.name}</code>
          <span className="truncate">{item.target}</span>
          <span className="ml-auto flex items-center gap-2">
            {isComputerTool(item.name) && (
              <span className="opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100 motion-reduce:transition-none">
                <ShowOnComputer onClick={onOpenScreen} />
              </span>
            )}
            {t(
              `transcript.tool.${item.state === 'running' && (bot.status === 'paused' || bot.status === 'human') ? 'paused' : item.state}`
            )}
          </span>
        </div>
        <BotTranscriptImages botId={bot.id} images={item.images} cache={imageCache} />
      </div>
    )
  if (item.kind === 'permission' || item.kind === 'question' || item.kind === 'help')
    return <InteractionCard botId={bot.id} item={item} fleet={fleet} onOpenScreen={onOpenScreen} />
  if (item.kind === 'peer_out')
    return (
      <div className="rounded-lg border border-dashed border-border p-3 text-sm">
        <div className="text-xs text-muted-foreground">
          {t('transcript.wroteTo', { bot: item.to.name })} · {at}
        </div>
        <p className="mt-1">{item.text}</p>
        <span className="text-xs text-muted-foreground">
          {t(item.delivered ? 'transcript.delivered' : 'transcript.notDelivered')}
        </span>
      </div>
    )
  return (
    <div className="text-center text-xs text-muted-foreground">
      {t(`transcript.system.${item.code}`, {
        duration: item.durationMs ? Math.round(item.durationMs / 1000) : 0,
      })}
      {item.text && (
        <span className="ml-1">
          {item.text === 'pdf-unreadable'
            ? t('files.unreadablePdf')
            : item.text === 'invalid-attachment'
              ? t('files.invalidAttachment')
              : item.text}
        </span>
      )}
    </div>
  )
}

/** A bot turn's reasoning and tool calls, folded into one line like a chat message's. */
function BotAgentActivity({
  bot,
  segment,
  imageCache,
  onShowOnComputer,
}: {
  bot: FleetBot
  segment: Extract<FleetActivitySegment, { kind: 'activity' }>
  imageCache: FleetImageCache
  onShowOnComputer: () => void
}) {
  const { t } = useTranslation('fleet')
  return (
    <AgentActivity
      steps={segment.steps}
      live={segment.live}
      writing={segment.writing}
      waitingYou={segment.live && bot.status === 'waiting'}
      toolAction={(step) => (isComputerTool(step.toolName) ? <ShowOnComputer onClick={onShowOnComputer} /> : null)}
      renderToolDetail={(step) => {
        const item = step.source
        if (item.kind !== 'tool') return null
        return (
          <div className="min-w-0 rounded-lg border border-border bg-white/[0.02] px-3 py-2 text-xs">
            {item.output ? (
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2 font-mono text-[12px] text-foreground/90">
                {item.output}
              </pre>
            ) : (
              !item.images.length && <p className="text-muted-foreground">{t('transcript.noOutput')}</p>
            )}
            <BotTranscriptImages botId={bot.id} images={item.images} cache={imageCache} />
          </div>
        )
      }}
      reasoningNote={(step) =>
        step.source.kind === 'reasoning' && step.source.truncated ? (
          <p className="mt-2 text-xs not-italic">{t('chat:activity.truncated')}</p>
        ) : null
      }
    />
  )
}

export function BotConversation({
  bot,
  fleet,
  visible = true,
  onOpenBot,
  onOpenScreen,
  onOpenSettings,
  onOpenEnvironmentScreen,
  onGiveBack,
  onOpenEnvironmentSettings,
}: {
  bot: FleetBot
  fleet: FleetController
  visible?: boolean
  onOpenBot: (id: string) => void
  onOpenScreen: () => void
  onOpenSettings: () => void
  onOpenEnvironmentScreen?: () => void
  /** The owner controls the computer: reveals it and asks about handing control back. */
  onGiveBack: () => void
  onOpenEnvironmentSettings?: (target: 'skills' | 'mcp') => void
}) {
  const { t } = useTranslation('fleet')
  const transcript = fleet.state.transcripts[bot.id]
  const imageCache = fleetImageCache
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const oldHeightRef = useRef<number | null>(null)
  const scrollTopRef = useRef(0)
  useEffect(() => {
    fleet.ensureTranscript(bot.id)
  }, [bot.id, fleet.ensureTranscript])
  useLayoutEffect(() => {
    const node = scrollRef.current
    if (!node || !visible) return
    if (oldHeightRef.current !== null) {
      node.scrollTop = scrollTopRef.current + node.scrollHeight - oldHeightRef.current
      oldHeightRef.current = null
    } else if (atBottomRef.current) node.scrollTop = node.scrollHeight
    else node.scrollTop = scrollTopRef.current
    scrollTopRef.current = node.scrollTop
  }, [transcript?.items, visible])
  const locked = ['paused', 'human', 'offline', 'starting', 'setup'].includes(bot.status)
  const lastItem = transcript?.items.at(-1)
  const runningToolLast = lastItem?.kind === 'tool' && lastItem.state === 'running'
  const compact = useAgentActivityMode() === 'compact'
  const visibleItems = visibleTranscriptItems(transcript?.items ?? [])
  const latestTodoId = latestTodoItemId(visibleItems)
  const segments: FleetActivitySegment[] = compact
    ? fleetActivitySegments(visibleItems, { working: bot.status === 'working' || bot.status === 'waiting' })
    : visibleItems.map((item) => ({ kind: 'item', item }))
  // A live activity line already says what the bot is doing.
  const liveLine = segments.some((segment) => segment.kind === 'activity' && segment.live)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        data-bot-transcript-scroll
        onScroll={(event) => {
          const node = event.currentTarget
          // Hiding a pane can emit a zero-position scroll. It must not replace the reading position.
          if (!visible || node.clientHeight === 0) return
          scrollTopRef.current = node.scrollTop
          atBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
          {transcript?.error && (
            <div role="alert" className="text-center text-xs text-destructive">
              {transcript.error}{' '}
              <button
                type="button"
                className="ml-2 text-primary underline"
                onClick={() => void fleet.loadTranscript(bot.id).catch(() => {})}
              >
                {t('transcript.retry')}
              </button>
            </div>
          )}
          {transcript?.before && (
            <button
              type="button"
              disabled={transcript.loading}
              className="self-center rounded-md border border-border px-3 py-1.5 text-xs"
              onClick={() => {
                oldHeightRef.current = scrollRef.current?.scrollHeight ?? null
                void fleet
                  .loadTranscript(bot.id, transcript.before)
                  .catch((cause) => setError(fleetErrorMessage(cause)))
              }}
            >
              {t('transcript.loadOlder')}
            </button>
          )}
          {segments.map((segment) =>
            segment.kind === 'activity' ? (
              <BotAgentActivity
                key={segment.key}
                bot={bot}
                segment={segment}
                imageCache={imageCache}
                onShowOnComputer={onOpenScreen}
              />
            ) : segment.kind === 'images' ? (
              // The images the bot shared: the tool stays in the activity, with its images in its details.
              <BotTranscriptImages
                key={`images:${segment.item.id}`}
                botId={bot.id}
                images={segment.item.images}
                cache={imageCache}
                size="large"
              />
            ) : (
              <TranscriptRow
                key={segment.item.id}
                bot={bot}
                item={segment.item}
                fleet={fleet}
                onOpenBot={onOpenBot}
                onOpenScreen={onOpenScreen}
                imageCache={imageCache}
                latestTodoId={latestTodoId}
              />
            )
          )}
          {bot.status === 'working' && !runningToolLast && !liveLine && (
            <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
              {t('transcript.working')}
            </div>
          )}
        </div>
      </div>
      <div className="border-t border-border px-4 py-3">
        <div className="mx-auto max-w-3xl">
          {locked && (
            <div className="flex items-center justify-between rounded-lg border border-border bg-surface-elevated p-3 text-sm text-muted-foreground">
              <span>
                {bot.status === 'setup' && bot.activity?.kind === 'setup' && bot.activity.need === 'compaction'
                  ? t('composer.setupCompaction')
                  : t(`composer.${bot.status}`)}
              </span>
              {bot.status === 'offline' && (
                <button type="button" className="text-primary" onClick={() => void startBot(fleet, bot)}>
                  {t('action.start')}
                </button>
              )}
              {bot.status === 'human' && ownsTakeover(bot.takeover, fleet.state.connection.deviceId) && (
                <Button size="sm" className="rounded-full px-4" onClick={onGiveBack}>
                  {t('screen.give')}
                </Button>
              )}
              {bot.status === 'paused' && (
                <button
                  type="button"
                  className="text-primary disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={takeoverBlocksResume(bot.takeover)}
                  title={takeoverBlocksResume(bot.takeover) ? t('action.resumeBlocked') : undefined}
                  onClick={() => void fleet.botAction(bot.id, 'resume')}
                >
                  {t('action.resume')}
                </button>
              )}
              {bot.status === 'setup' &&
                (bot.activity?.kind === 'setup' && bot.activity.need === 'compaction' ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <button type="button" className="text-primary" onClick={onOpenSettings}>
                      {t('composer.chooseCompactionModel')}
                    </button>
                  </span>
                ) : (
                  <span className="flex flex-wrap gap-2">
                    <button type="button" className="text-primary" onClick={onOpenScreen}>
                      {t('composer.connectAccount')}
                    </button>
                    <button type="button" className="text-primary" onClick={onOpenSettings}>
                      {t('composer.addApiKeyInSettings')}
                    </button>
                  </span>
                ))}
            </div>
          )}
          <BotComposer
            bot={bot}
            fleet={fleet}
            onOpenScreen={onOpenScreen}
            onOpenSettings={onOpenSettings}
            onOpenEnvironmentScreen={onOpenEnvironmentScreen}
            onOpenEnvironmentSettings={onOpenEnvironmentSettings}
          />
          {error && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
