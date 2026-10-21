import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, HardDrive, Loader2, Pencil, Wrench, X } from 'lucide-react'
import {
  FLEET_MESSAGE_EDIT_FEATURE,
  type FleetBot,
  type FleetRoutine,
  type FleetRoutineRun,
  type FleetTranscriptItem,
} from '@maestrly/bot-fleet-protocol'
import { MarkdownViewer } from '@/components/MarkdownViewer'
import { GenUiContext, type GenUiHost } from '@/genui/context'
import { fileSizeLabel } from '@/lib/fleet/downloads'
import { filesCountLevel, filesLevel } from '@/lib/fleet/files'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { ownsTakeover, takeoverBlocksResume, UNKNOWN_BOT_TINT } from '@/lib/fleet/selectors'
import { startBot } from '@/lib/fleet/environments'
import { accountsExhaustedNotice, isComputerTool } from '@/lib/fleet/format'
import {
  editableMessageId,
  latestTodoItemId,
  repeatedRoutineRunIds,
  ROUTINE_ACTIVITY_KINDS,
  routineScheduleSummary,
  visibleTranscriptItems,
} from '@/lib/fleet/forms'
import { Button } from '@/components/ui/button'
import { TodoList } from '@/components/chat/TodoCard'
import { InteractionCard } from './InteractionCard'
import { fleetErrorMessage, isEditConflict, isEditUnsupported } from '@/lib/fleet/errors'
import { fleetImageCache, type FleetImageCache } from '@/lib/fleet/image-cache'
import { BotComposer } from './BotComposer'
import { BotTranscriptImages } from './BotTranscriptImages'
import { BotTranscriptFiles } from './BotTranscriptFiles'
import { BotTaskItem } from './BotTaskItem'
import { BotPeerMessage } from './BotPeerMessage'
import { PeerThreadBridge } from './PeerThreadBridge'
import { BotRoutineMessage } from './BotRoutineMessage'
import { RoutineRunMarker, RunCitationChip } from './RoutineRunMarker'
import { runTitle } from '@/lib/fleet/runs'
import { AgentActivity } from '@/components/chat/AgentActivity'
import { useAgentActivityMode } from '@/lib/agent-activity-preference'
import { ArtifactCard } from '../artifacts/ArtifactCard'
import { parseArtifactToolResult } from '../../../shared/artifacts'
import { baseToolName, fleetActivitySegments, type FleetActivitySegment } from '@/lib/agent-activity'
import { ChatSearchBar } from '@/components/chat/ChatSearchBar'
import { findCaseInsensitiveRanges } from '@/lib/markdown-search-highlight'
import { scrollChatSearchResult } from '@/lib/chat-search-scroll'
import { useChatOwnerWindow } from '@/lib/chat-window-context'
import { searchTranscriptSegments, transcriptSegmentKey } from '@/lib/fleet/transcript-search'
import { primaryWorking, runsInParallel, sideTurns } from '@/lib/fleet/turns'
import { cn } from '@/lib/utils'

/** A bot this server no longer lists, or one in an environment this device cannot see. */

/** A bot's answer: each generated interface renders once its block is complete, and sends through the bot. */
function BotAnswer({
  text,
  streaming,
  onInterfaceSend,
  searchQuery,
  currentSearchMatch,
}: {
  text: string
  streaming: boolean
  onInterfaceSend?: (text: string) => void
  searchQuery?: string
  currentSearchMatch?: boolean
}) {
  const host = useMemo<GenUiHost>(() => ({ live: streaming, send: onInterfaceSend }), [onInterfaceSend, streaming])
  return (
    <GenUiContext.Provider value={host}>
      <MarkdownViewer markdown={text} searchQuery={searchQuery} currentSearchMatch={currentSearchMatch} />
    </GenUiContext.Provider>
  )
}

/** Plain transcript text with the search matches marked like a chat message's Markdown. */
function SearchText({ text, query, current }: { text: string; query?: string; current?: boolean }) {
  const ranges = query ? findCaseInsensitiveRanges(text, query) : []
  if (!ranges.length) return <>{text}</>
  const parts: ReactNode[] = []
  let cursor = 0
  ranges.forEach((range, index) => {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start))
    parts.push(
      <mark key={index} className={cn('chat-search-match', current && 'chat-search-match--current')}>
        {text.slice(range.start, range.end)}
      </mark>
    )
    cursor = range.end
  })
  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}

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

/** The owner's last message, edited in place like a chat's: Escape cancels and Enter sends. */
function BotMessageEditor({
  value,
  allowEmpty,
  onChange,
  onCancel,
  onSubmit,
}: {
  value: string
  /** The message keeps its attachments, so it may lose its text. */
  allowEmpty: boolean
  onChange: (value: string) => void
  onCancel: () => void
  onSubmit: () => void
}) {
  const { t } = useTranslation('fleet')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    node.focus()
    node.setSelectionRange(node.value.length, node.value.length)
  }, [])
  const sendable = allowEmpty || value.trim().length > 0
  return (
    <div className="rounded-xl border border-white/[0.12] bg-white/[0.05] px-3.5 py-2.5">
      <textarea
        ref={ref}
        value={value}
        aria-label={t('transcript.edit.action')}
        rows={Math.min(10, Math.max(2, value.split('\n').length))}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            // The conversation's search closes on Escape too: only the editor closes here.
            event.stopPropagation()
            onCancel()
          } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            if (sendable) onSubmit()
          }
        }}
        className="max-h-[240px] w-full resize-none overflow-y-auto bg-transparent text-sm focus-visible:outline-none"
      />
      <p className="mt-1 text-xs text-muted-foreground">{t('transcript.edit.hint')}</p>
      <div className="mt-1.5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-white/10 px-2.5 py-1 text-[12px] text-muted-foreground hover:bg-white/5"
        >
          {t('transcript.edit.cancel')}
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={!sendable}
          className="rounded-md bg-indigo-500 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-indigo-400 disabled:opacity-50"
        >
          {t('transcript.edit.send')}
        </button>
      </div>
    </div>
  )
}

/** Editing the owner's last message: offered on the one message that may be edited. */
export interface RowEdit {
  editable: boolean
  draft: string | null
  onStart: () => void
  onChange: (value: string) => void
  onCancel: () => void
  onSubmit: () => void
}

/** One item of a bot's transcript: of its own conversation, or of a routine run's. */
export function TranscriptRow({
  bot,
  item,
  fleet,
  onOpenBot,
  onOpenScreen,
  imageCache,
  latestTodoId,
  searchQuery,
  currentSearchMatch,
  edit,
  onInterfaceSend,
  routineSchedule,
  repeatedRoutine,
  onExpand,
  onOpenRun,
  onOpenThread,
  removeQueuedMessage,
}: {
  bot: FleetBot
  imageCache: FleetImageCache
  item: FleetTranscriptItem
  fleet: FleetController
  onOpenBot: (id: string) => void
  onOpenScreen: () => void
  latestTodoId: string | null
  searchQuery?: string
  currentSearchMatch?: boolean
  edit?: RowEdit
  /** Sends what a generated interface asks to send as the owner; absent while the bot cannot take messages. */
  onInterfaceSend?: (text: string) => void
  /** A routine run: how its routine runs, when known. */
  routineSchedule: string | null
  /** A routine run with the same instructions as the previous one. */
  repeatedRoutine: boolean
  /** A folded row unfolds: the transcript keeps the owner's reading position. */
  onExpand: () => void
  /** Opens the routine run an owner's message refers to. */
  onOpenRun?: (runId: string) => void
  /** Opens the conversation with another bot that a message of the bot opened (`peer-conversations`). */
  onOpenThread?: (threadId: string) => void
  /** Removes a queued message; a run's conversation removes its own. */
  removeQueuedMessage?: (inputId: string) => Promise<void>
}) {
  const serverId = fleet.serverId
  const { t, i18n } = useTranslation('fleet')
  const at = new Date(item.at).toLocaleTimeString(i18n.language, {
    hour: '2-digit',
    minute: '2-digit',
  })
  const exhaustedText = (text: string): string | null => {
    const notice = accountsExhaustedNotice(text)
    if (!notice) return null
    const sameDay = notice.until?.toDateString() === new Date().toDateString()
    const time = notice.until?.toLocaleString(
      i18n.language,
      sameDay ? { hour: '2-digit', minute: '2-digit' } : { dateStyle: 'short', timeStyle: 'short' }
    )
    return `${t(`transcript.accountsExhausted.${notice.kind}`)} ${
      time ? t('transcript.accountsExhausted.until', { time }) : t('transcript.accountsExhausted.queued')
    }`
  }
  const removeQueued = () =>
    void (
      removeQueuedMessage
        ? removeQueuedMessage(item.id.replace(/^input:/, ''))
        : window.api
            .fleetRemoveQueuedMessage(serverId, bot.id, item.id.replace(/^input:/, ''))
            .then(() => fleet.loadTranscript(bot.id))
    ).catch(() => {})
  const fleetBot = (id: string | undefined) => fleet.state.snapshot.bots.find((peer) => peer.id === id)
  if (item.kind === 'user') {
    if (item.source === 'peer') {
      const peer = fleetBot(item.peer?.botId)
      return (
        <BotPeerMessage
          from={{ name: item.peer?.name ?? peer?.name ?? '', tint: peer?.tint ?? UNKNOWN_BOT_TINT }}
          to={bot}
          at={at}
          text={item.text}
          meta={
            item.stopped ? (
              <span title={t('transcript.stoppedHint')} className="inline-flex items-center gap-1 text-amber-300">
                {t('transcript.stopped')}
                <button
                  type="button"
                  aria-label={t('transcript.removeQueued')}
                  className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                  onClick={removeQueued}
                >
                  <X className="size-3" />
                </button>
              </span>
            ) : item.queued ? (
              t('transcript.queued')
            ) : undefined
          }
          footer={
            item.memories.length > 0 &&
            t('conversation.recalled', { titles: item.memories.map((memory) => memory.title).join(', ') })
          }
          onOpenPeer={peer ? () => onOpenBot(peer.id) : undefined}
          onExpand={onExpand}
          searchQuery={searchQuery}
          currentSearchMatch={currentSearchMatch}
        />
      )
    }
    if (item.source === 'routine')
      return (
        <BotRoutineMessage
          title={item.routine?.title || t('transcript.routine.label')}
          schedule={routineSchedule}
          at={at}
          text={item.text}
          repeated={repeatedRoutine}
          memories={item.memories}
          queued={item.queued}
          stopped={item.stopped}
          onRemoveQueued={removeQueued}
          onExpand={onExpand}
          searchQuery={searchQuery}
          currentSearchMatch={currentSearchMatch}
        />
      )
    if (edit?.draft != null)
      return (
        <div className="ml-auto flex w-[85%] flex-col gap-2">
          <BotMessageEditor
            value={edit.draft}
            allowEmpty={item.images.length > 0 || (item.files?.length ?? 0) > 0}
            onChange={edit.onChange}
            onCancel={edit.onCancel}
            onSubmit={edit.onSubmit}
          />
          <BotTranscriptImages botId={bot.id} images={item.images} cache={imageCache} />
          <BotTranscriptFiles botId={bot.id} files={item.files} />
        </div>
      )
    return (
      <div className="group/message ml-auto max-w-[85%] rounded-xl border border-border-strong bg-surface-elevated px-4 py-3 text-sm">
        {item.citation && (
          <div className="mb-1.5">
            <RunCitationChip
              title={item.citation.routineTitle || t('transcript.routine.label')}
              at={item.citation.at}
              onOpen={onOpenRun ? () => onOpenRun(item.citation!.runId) : undefined}
            />
          </div>
        )}
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
          <SearchText text={item.text} query={searchQuery} current={currentSearchMatch} />
        </p>
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
          {edit?.editable && (
            <button
              type="button"
              title={t('transcript.edit.action')}
              aria-label={t('transcript.edit.action')}
              onClick={edit.onStart}
              className="rounded p-0.5 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/message:opacity-100 motion-reduce:transition-none"
            >
              <Pencil className="size-3" />
            </button>
          )}
          {at}
          {item.queued && (
            <>
              {item.stopped ? (
                <span title={t('transcript.stoppedHint')} className="text-amber-300">
                  {t('transcript.stopped')}
                </span>
              ) : (
                t(item.attachmentError ? 'files.notSent' : 'transcript.queued')
              )}
              <button
                type="button"
                aria-label={t('transcript.removeQueued')}
                className="rounded p-0.5 hover:text-destructive"
                onClick={removeQueued}
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
        <BotAnswer
          text={item.text}
          streaming={!!item.streaming}
          onInterfaceSend={onInterfaceSend}
          searchQuery={searchQuery}
          currentSearchMatch={currentSearchMatch}
        />
        {item.streaming && <span className="text-xs text-muted-foreground">{t('transcript.streaming')}</span>}
        <span className="mt-1 block text-xs text-muted-foreground">{at}</span>
      </div>
    )
  if (item.kind === 'reasoning')
    return (
      <div className="max-w-[90%] rounded-lg border border-white/[0.06] bg-white/[0.015] px-3 py-2 text-[13px] italic text-muted-foreground">
        <MarkdownViewer markdown={item.text} searchQuery={searchQuery} currentSearchMatch={currentSearchMatch} />
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
              <MarkdownViewer
                markdown={item.summary}
                searchQuery={searchQuery}
                currentSearchMatch={currentSearchMatch}
              />
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
  // A task the bot started: a row of its own, with its difficulty, model and result. Older instances send no task.
  if (item.kind === 'tool' && item.task)
    return <BotTaskItem item={{ ...item, task: item.task }} bot={bot} imageCache={imageCache} />
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
  if (item.kind === 'peer_out') {
    const peer = fleetBot(item.to.botId)
    const threadId = item.thread?.id
    if (threadId && onOpenThread) {
      const threads = fleet.state.threads[bot.id]
      return (
        <PeerThreadBridge
          bot={bot}
          peer={{ name: item.to.name, tint: peer?.tint ?? UNKNOWN_BOT_TINT }}
          text={item.text}
          at={at}
          thread={threads?.loaded ? (threads.threads.find((thread) => thread.id === threadId) ?? null) : undefined}
          onOpen={() => onOpenThread(threadId)}
        />
      )
    }
    return (
      <BotPeerMessage
        from={bot}
        to={{ name: item.to.name, tint: peer?.tint ?? UNKNOWN_BOT_TINT }}
        at={at}
        text={item.text}
        footer={t(item.delivered ? 'transcript.delivered' : 'transcript.notDelivered')}
        onOpenPeer={peer ? () => onOpenBot(peer.id) : undefined}
        onExpand={onExpand}
        searchQuery={searchQuery}
        currentSearchMatch={currentSearchMatch}
      />
    )
  }
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
              : item.text === 'context-compaction-failed'
                ? t('transcript.contextFailed.compaction')
                : item.text === 'context-overflow'
                  ? t('transcript.contextFailed.overflow')
                  : (exhaustedText(item.text) ?? item.text)}
        </span>
      )}
    </div>
  )
}

/** A bot turn's reasoning and tool calls, folded into one line like a chat message's. */
export function BotAgentActivity({
  bot,
  segment,
  imageCache,
  onShowOnComputer,
  searchQuery,
  currentSearchMatch,
}: {
  bot: FleetBot
  segment: Extract<FleetActivitySegment, { kind: 'activity' }>
  imageCache: FleetImageCache
  onShowOnComputer: () => void
  searchQuery?: string
  currentSearchMatch?: boolean
}) {
  const { t } = useTranslation('fleet')
  return (
    <AgentActivity
      searchQuery={searchQuery}
      currentSearchMatch={currentSearchMatch}
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
  runMarkers = [],
  onOpenRun,
  onOpenThread,
  citation = null,
  onClearCitation,
  onOpenFiles,
  revealFile = null,
  onRevealed,
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
  /** Routine runs that finished, shown where they ended (`routine-conversations`); none before. */
  runMarkers?: FleetRoutineRun[]
  onOpenRun?: (runId: string) => void
  /** Opens a conversation with another bot that this conversation opened (`peer-conversations`). */
  onOpenThread?: (threadId: string) => void
  /** The run the owner's next message refers to, and how to drop it. */
  citation?: FleetRoutineRun | null
  onClearCitation?: () => void
  onOpenFiles?: () => void
  revealFile?: { id: string; nonce: number } | null
  onRevealed?: (found: boolean) => void
}) {
  const serverId = fleet.serverId
  const { t, i18n } = useTranslation('fleet')
  const transcript = fleet.state.transcripts[bot.id]
  const imageCache = fleetImageCache(serverId)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const oldHeightRef = useRef<number | null>(null)
  const scrollTopRef = useRef(0)
  const visibleRef = useRef(visible)
  visibleRef.current = visible
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
  useEffect(() => {
    const node = scrollRef.current
    const content = contentRef.current
    if (!node || !content) return
    // The transcript renders through a portal that is attached after its first layout, and markdown or images grow
    // it later: keep following the end while the reader is there.
    const observer = new ResizeObserver(() => {
      if (!visibleRef.current || node.clientHeight === 0) return
      if (atBottomRef.current) node.scrollTop = node.scrollHeight
      scrollTopRef.current = node.scrollTop
    })
    observer.observe(node)
    observer.observe(content)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!revealFile) return
    const node = scrollRef.current
    const card = node?.querySelector<HTMLElement>(`[data-file-id="${revealFile.id}"]`) ?? null
    if (!card) {
      onRevealed?.(false)
      return
    }
    atBottomRef.current = false
    setAtBottom(false)
    card.scrollIntoView({ behavior: 'smooth', block: 'center' })
    card.classList.add('bot-file-flash')
    onRevealed?.(true)
    const timer = setTimeout(() => card.classList.remove('bot-file-flash'), 1900)
    return () => {
      clearTimeout(timer)
      card.classList.remove('bot-file-flash')
    }
  }, [revealFile, onRevealed])
  const scrollToBottom = () => {
    const node = scrollRef.current
    if (!node) return
    atBottomRef.current = true
    setAtBottom(true)
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' })
  }
  const locked = ['paused', 'human', 'offline', 'starting', 'setup'].includes(bot.status)
  const lastItem = transcript?.items.at(-1)
  const runningToolLast = lastItem?.kind === 'tool' && lastItem.state === 'running'
  const compact = useAgentActivityMode() === 'compact'
  const transcriptItems = transcript?.items
  const visibleItems = useMemo(() => visibleTranscriptItems(transcriptItems ?? []), [transcriptItems])

  // --- Editing the owner's last message, like a chat's: the bot's conversation runs again from it. ---
  const editSupported =
    fleet.state.connection.features.includes(FLEET_MESSAGE_EDIT_FEATURE) &&
    bot.capabilities.includes(FLEET_MESSAGE_EDIT_FEATURE)
  const editableId = useMemo(
    () => (editSupported && bot.status === 'idle' ? editableMessageId(transcriptItems ?? []) : null),
    [bot.status, editSupported, transcriptItems]
  )
  const [editing, setEditing] = useState<{ itemId: string; draft: string } | null>(null)
  // While an edit is on its way the transcript already shows it: the edited message, and nothing after it.
  const [sentEdit, setSentEdit] = useState<{ itemId: string; text: string } | null>(null)
  useEffect(() => {
    setEditing(null)
    setSentEdit(null)
  }, [bot.id])
  const shownItems = useMemo(() => {
    const index = sentEdit ? visibleItems.findIndex((item) => item.id === sentEdit.itemId) : -1
    if (!sentEdit || index < 0) return visibleItems
    const edited = visibleItems[index]
    return [...visibleItems.slice(0, index), edited.kind === 'user' ? { ...edited, text: sentEdit.text } : edited]
  }, [sentEdit, visibleItems])
  const submitEdit = async () => {
    if (!editing || sentEdit) return
    const { itemId, draft } = editing
    const text = draft.trim()
    setError(null)
    setEditing(null)
    setSentEdit({ itemId, text })
    try {
      await window.api.fleetEditMessage(serverId, bot.id, itemId.replace(/^input:/, ''), text)
      await fleet.loadTranscript(bot.id).catch(() => {})
    } catch (cause) {
      setEditing({ itemId, draft })
      setError(
        isEditConflict(cause)
          ? t('transcript.edit.conflict')
          : isEditUnsupported(cause)
            ? t('transcript.edit.unsupported')
            : fleetErrorMessage(cause)
      )
    } finally {
      setSentEdit(null)
    }
  }
  const rowEdit = (item: FleetTranscriptItem): RowEdit | undefined => {
    const draft = editing?.itemId === item.id ? editing.draft : null
    if (item.kind !== 'user' || (item.id !== editableId && draft === null)) return undefined
    return {
      editable: item.id === editableId && !sentEdit,
      draft,
      onStart: () => {
        setError(null)
        setEditing({ itemId: item.id, draft: item.text })
      },
      onChange: (value) => setEditing({ itemId: item.id, draft: value }),
      onCancel: () => setEditing(null),
      onSubmit: () => void submitEdit(),
    }
  }

  const latestTodoId = latestTodoItemId(shownItems)
  // The routine run working beside this conversation, which the composer names.
  const sideRun = sideTurns(bot).find((turn) => turn.kind === 'routine') ?? null
  // A routine run works in a conversation of its own: only this conversation's own turn makes it work.
  const working = primaryWorking(bot) || (bot.status === 'waiting' && !bot.runningRun)

  // --- Routine runs say how their routine runs, which the transcript does not carry. ---
  const hasRoutineRuns = useMemo(
    () => shownItems.some((item) => item.kind === 'user' && item.source === 'routine'),
    [shownItems]
  )
  const routineActivitySeq =
    fleet.state.activity.findLast((entry) => entry.botId === bot.id && ROUTINE_ACTIVITY_KINDS.includes(entry.kind))
      ?.seq ?? 0
  const [routines, setRoutines] = useState<{ botId: string; list: FleetRoutine[] } | null>(null)
  useEffect(() => {
    if (!hasRoutineRuns) return
    let alive = true
    void window.api
      .fleetListRoutines(serverId, bot.id)
      .then((result) => {
        if (alive) setRoutines({ botId: bot.id, list: result.routines })
      })
      // Without the list, a run shows without its schedule.
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [bot.id, hasRoutineRuns, routineActivitySeq])
  const routineSchedules = useMemo(() => {
    const schedules = new Map<string, string>()
    if (routines?.botId !== bot.id) return schedules
    const dayLabels = [1, 2, 3, 4, 5, 6, 7].map((day) => t(`routine.day.${day}`))
    for (const routine of routines.list) {
      const summary = routineScheduleSummary(routine.schedule, dayLabels, t('routine.schedule.everyDay'))
      schedules.set(routine.id, t(summary.key, summary.values))
    }
    return schedules
  }, [bot.id, routines, t])
  const repeatedRoutines = useMemo(() => repeatedRoutineRunIds(shownItems), [shownItems])

  // A generated interface sends as the owner, like the composer; the instance queues it while the bot works.
  const sendFromInterface = useCallback(
    (text: string) => {
      setError(null)
      void window.api
        .fleetSendMessage(serverId, bot.id, text)
        .then(() => fleet.loadTranscript(bot.id))
        .catch((cause) => setError(fleetErrorMessage(cause)))
    },
    [bot.id, fleet.loadTranscript]
  )
  const interfaceSend = locked ? undefined : sendFromInterface
  // Interfaces inside the activity (reasoning, interim text) wait for the turn; each answer follows its own stream.
  const transcriptHost = useMemo<GenUiHost>(() => ({ live: working, send: interfaceSend }), [interfaceSend, working])
  const segments = useMemo<FleetActivitySegment[]>(
    () =>
      compact ? fleetActivitySegments(shownItems, { working }) : shownItems.map((item) => ({ kind: 'item', item })),
    [compact, shownItems, working]
  )
  // A live activity line already says what the bot is doing.
  const liveLine = segments.some((segment) => segment.kind === 'activity' && segment.live)
  // Finished routine runs show where they ended; before the oldest item loaded only once the whole history is.
  const markersBefore = useMemo(() => {
    const oldest = shownItems[0]?.at
    const shown = runMarkers
      .filter((run) => !transcript?.before || (oldest && (run.finishedAt ?? run.deliveredAt) >= oldest))
      .sort((a, b) => ((a.finishedAt ?? a.deliveredAt) < (b.finishedAt ?? b.deliveredAt) ? -1 : 1))
    const at = (segment: FleetActivitySegment) =>
      segment.kind === 'activity' ? (segment.steps[0]?.source.at ?? '') : segment.item.at
    const byKey = new Map<string, FleetRoutineRun[]>()
    const trailing: FleetRoutineRun[] = []
    let index = 0
    for (const run of shown) {
      const time = run.finishedAt ?? run.deliveredAt
      while (index < segments.length && at(segments[index]) <= time) index++
      if (index >= segments.length) trailing.push(run)
      else {
        const key = transcriptSegmentKey(segments[index])
        byKey.set(key, [...(byKey.get(key) ?? []), run])
      }
    }
    return { byKey, trailing }
  }, [runMarkers, segments, shownItems, transcript?.before])
  const marker = (run: FleetRoutineRun) => (
    <div key={'run:' + run.id} className="@container">
      <RoutineRunMarker run={run} botName={bot.name} onOpen={() => onOpenRun?.(run.id)} />
    </div>
  )

  // --- Search (Cmd/Ctrl+F), like a chat's. ---
  const ownerWindow = useChatOwnerWindow()
  // An unfolding row grows under the owner's eyes: following the end would scroll what they opened away.
  const holdReadingPosition = useCallback(() => {
    atBottomRef.current = false
    ownerWindow.requestAnimationFrame(() => {
      const node = scrollRef.current
      if (!node) return
      atBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
      setAtBottom(atBottomRef.current)
    })
  }, [ownerWindow])
  const { loadTranscript } = fleet
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [currentHitKey, setCurrentHitKey] = useState<string | null>(null)
  const [searchJump, setSearchJump] = useState(0)
  useEffect(() => {
    if (!searchOpen) return
    const query = searchQuery.trim()
    const handle = setTimeout(
      () => {
        setAppliedQuery(query)
        setCurrentHitKey(null)
      },
      query ? 180 : 0
    )
    return () => clearTimeout(handle)
  }, [searchOpen, searchQuery])
  // The instance only pages its transcript, so a search loads the older pages to cover the whole conversation.
  const searchBefore = searchOpen && appliedQuery && !transcript?.error ? (transcript?.before ?? null) : null
  const transcriptLoading = !!transcript?.loading
  useEffect(() => {
    if (!searchBefore || transcriptLoading) return
    oldHeightRef.current = scrollRef.current?.scrollHeight ?? null
    void loadTranscript(bot.id, searchBefore).catch(() => {})
  }, [bot.id, loadTranscript, searchBefore, transcriptLoading])
  const searchHits = useMemo(
    () => (searchOpen ? searchTranscriptSegments(segments, appliedQuery) : []),
    [appliedQuery, searchOpen, segments]
  )
  const searchHitKeys = useMemo(() => new Set(searchHits), [searchHits])
  const searchIndex = currentHitKey ? searchHits.indexOf(currentHitKey) : -1
  useEffect(() => {
    // A new query, or a hit that left the transcript, starts at the newest match.
    if (!searchHits.length || (currentHitKey && searchHits.includes(currentHitKey))) return
    setCurrentHitKey(searchHits[searchHits.length - 1])
    setSearchJump((value) => value + 1)
  }, [currentHitKey, searchHits])
  useEffect(() => {
    if (!searchJump || !currentHitKey) return
    const frame = ownerWindow.requestAnimationFrame(() => {
      const node = scrollRef.current?.querySelector<HTMLElement>(`[data-search-key="${CSS.escape(currentHitKey)}"]`)
      if (!node) return
      const isRevealed = (match: HTMLElement) => {
        let details = match.closest('details')
        while (details) {
          if (!details.open) return false
          details = details.parentElement?.closest('details') ?? null
        }
        return true
      }
      scrollChatSearchResult(
        node.querySelectorAll<HTMLElement>('.chat-search-match--current'),
        node.querySelectorAll<HTMLElement>('.chat-search-match'),
        // The wrapper is `display: contents` and has no box to scroll to.
        (node.firstElementChild as HTMLElement | null) ?? node,
        isRevealed
      )
    })
    return () => ownerWindow.cancelAnimationFrame(frame)
  }, [currentHitKey, ownerWindow, searchJump])
  const stepSearch = useCallback(
    (direction: 1 | -1) => {
      if (!searchHits.length) return
      const from = searchIndex < 0 ? searchHits.length - 1 : searchIndex
      setCurrentHitKey(searchHits[(from + direction + searchHits.length) % searchHits.length])
      setSearchJump((value) => value + 1)
    },
    [searchHits, searchIndex]
  )
  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setSearchQuery('')
    setAppliedQuery('')
    setCurrentHitKey(null)
  }, [])
  useEffect(() => {
    if (!visible) return
    const onKey = (event: KeyboardEvent) => {
      // The bot's computer takes its own shortcuts while focused.
      if (event.defaultPrevented) return
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setSearchOpen(true)
      } else if (event.key === 'Escape' && searchOpen) closeSearch()
    }
    ownerWindow.addEventListener('keydown', onKey)
    return () => ownerWindow.removeEventListener('keydown', onKey)
  }, [closeSearch, ownerWindow, searchOpen, visible])
  const searchHighlight = searchOpen && appliedQuery && appliedQuery === searchQuery.trim() ? appliedQuery : undefined

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {searchOpen && (
        <ChatSearchBar
          query={searchQuery}
          onQueryChange={setSearchQuery}
          total={searchHits.length}
          index={searchIndex}
          loading={searchQuery.trim() !== appliedQuery || !!searchBefore}
          onPrev={() => stepSearch(-1)}
          onNext={() => stepSearch(1)}
          onClose={closeSearch}
        />
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          data-bot-transcript-scroll
          onScroll={(event) => {
            const node = event.currentTarget
            // Hiding a pane can emit a zero-position scroll. It must not replace the reading position.
            if (!visible || node.clientHeight === 0) return
            scrollTopRef.current = node.scrollTop
            atBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
            setAtBottom(atBottomRef.current)
          }}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden"
        >
          <div ref={contentRef} className="bot-transcript mx-auto flex min-w-0 max-w-3xl flex-col gap-4 px-6 py-6">
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
            <GenUiContext.Provider value={transcriptHost}>
              {segments.map((segment) => {
                const key = transcriptSegmentKey(segment)
                const query = searchHighlight && searchHitKeys.has(key) ? searchHighlight : undefined
                const current = key === currentHitKey
                return [
                  ...(markersBefore.byKey.get(key) ?? []).map(marker),
                  // `contents` keeps the transcript's layout: a row that renders nothing adds no gap.
                  <div key={key} data-search-key={key} className="contents">
                    {segment.kind === 'activity' ? (
                      <BotAgentActivity
                        bot={bot}
                        segment={segment}
                        imageCache={imageCache}
                        onShowOnComputer={onOpenScreen}
                        searchQuery={query}
                        currentSearchMatch={current}
                      />
                    ) : segment.kind === 'images' ? (
                      // The images the bot shared: the tool stays in the activity, with its images in its details.
                      <BotTranscriptImages
                        botId={bot.id}
                        images={segment.item.images}
                        cache={imageCache}
                        size="large"
                      />
                    ) : (
                      <TranscriptRow
                        bot={bot}
                        item={segment.item}
                        fleet={fleet}
                        onOpenBot={onOpenBot}
                        onOpenScreen={onOpenScreen}
                        imageCache={imageCache}
                        latestTodoId={latestTodoId}
                        searchQuery={query}
                        currentSearchMatch={current}
                        edit={rowEdit(segment.item)}
                        onInterfaceSend={interfaceSend}
                        routineSchedule={
                          segment.item.kind === 'user' && segment.item.routine
                            ? (routineSchedules.get(segment.item.routine.id) ?? null)
                            : null
                        }
                        repeatedRoutine={repeatedRoutines.has(segment.item.id)}
                        onExpand={holdReadingPosition}
                        onOpenRun={onOpenRun}
                        onOpenThread={onOpenThread}
                      />
                    )}
                  </div>,
                ]
              })}
              {markersBefore.trailing.map(marker)}
            </GenUiContext.Provider>
            {primaryWorking(bot) && !runningToolLast && !liveLine && (
              <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
                {t('transcript.working')}
              </div>
            )}
          </div>
        </div>
        {!atBottom && segments.length > 0 && (
          <button
            type="button"
            onClick={scrollToBottom}
            title={t('chat:messages.goToBottom')}
            aria-label={t('chat:messages.goToBottom')}
            className="absolute bottom-3 left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-white/[0.1] bg-[#1a1a1f] text-foreground shadow-lg transition hover:bg-[#26262d]"
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        )}
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
          {sideRun && (
            <p role="status" className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 aria-hidden="true" className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />
              <span className="min-w-0 flex-1 truncate">
                {/* Turns at once: the owner's message here does not wait for the run. */}
                {t(runsInParallel(bot) ? 'runs.alsoWorking' : 'runs.waiting', {
                  name: bot.name,
                  title: sideRun.title || t('transcript.routine.label'),
                })}
              </span>
              {onOpenRun && (
                <button
                  type="button"
                  className="shrink-0 text-sky-300 hover:underline"
                  onClick={() => onOpenRun(sideRun.id)}
                >
                  {t('runs.waitingOpen')}
                </button>
              )}
            </p>
          )}
          {citation && (
            <div className="mb-2">
              <RunCitationChip
                composing
                title={runTitle(citation, t('transcript.routine.label'))}
                at={citation.deliveredAt}
                onOpen={onOpenRun ? () => onOpenRun(citation.id) : undefined}
                onRemove={onClearCitation}
              />
            </div>
          )}
          {bot.sharedFiles && filesLevel(bot.sharedFiles) === 'full' && (
            <div
              role="status"
              className="mb-2 flex items-center gap-2.5 rounded-lg border border-red-400/35 bg-red-400/[0.06] px-3 py-2 text-xs text-red-200"
            >
              <HardDrive aria-hidden="true" className="size-3.5 shrink-0 text-red-300" />
              <span className="min-w-0 flex-1">
                {filesCountLevel(bot.sharedFiles) === 'full'
                  ? t('files.full.count', { name: bot.name, max: bot.sharedFiles.countMax })
                  : t('files.full.space', {
                      name: bot.name,
                      free: fileSizeLabel(
                        Math.max(0, bot.sharedFiles.quotaBytes - bot.sharedFiles.usedBytes),
                        i18n.language
                      ),
                    })}
              </span>
              {onOpenFiles && (
                <button
                  type="button"
                  onClick={onOpenFiles}
                  className="shrink-0 rounded-md border border-red-400/40 px-2.5 py-1 text-xs font-medium text-red-100 hover:bg-red-400/15"
                >
                  {t('files.full.action')}
                </button>
              )}
            </div>
          )}
          <BotComposer
            bot={bot}
            fleet={fleet}
            onOpenScreen={onOpenScreen}
            onOpenSettings={onOpenSettings}
            onOpenEnvironmentScreen={onOpenEnvironmentScreen}
            onOpenEnvironmentSettings={onOpenEnvironmentSettings}
            citation={citation?.id ?? null}
            onCitationSent={onClearCitation}
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
