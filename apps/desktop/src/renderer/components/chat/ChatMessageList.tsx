import { subscriptionExhaustionMessageKey } from './subscription-failover-route'
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  Copy,
  Check,
  Pencil,
  FileText,
  ScanText,
  TriangleAlert,
  Sparkles,
  ChevronRight,
  BrainCircuit,
} from 'lucide-react'
import { MarkdownViewer, type OpenFileReference } from '@/components/MarkdownViewer'
import { cn } from '@/lib/utils'
import { useSettings } from '@/lib/use-settings'
import { ToolCallCard } from './ToolCallCard'
import { SubagentCard } from './SubagentCard'
import { OrchestrationRun } from './OrchestrationRun'
import { QuestionCard } from './QuestionCard'
import { TodoCard } from './TodoCard'
import { GeneratedImageCard } from './GeneratedImageCard'
import { ChatImageLightbox } from './ChatImageLightbox'
import { AttachmentImage } from './AttachmentImage'
import { CUT_FINISH_REASONS, estimatedCostOfUsageWithSubagents, toolOutputText } from '../../../shared/chat'
import { formatResponseDuration, responseDurationMs } from '../../../shared/response-duration'
import type { ChatMessage, ChatModelMeta, MessagePart } from '../../../shared/chat'
import type { StructuredAgentMentionDraft } from '../../../shared/chat-agent-mentions'
import type { ConversationExperience } from '../../../shared/conversation-experience'
import type { SubagentAgentDto } from '../../../shared/subagent-profiles'
import { MentionEditor, type MentionEditorHandle } from './MentionEditor'

function textOnly(m: ChatMessage): string {
  return m.parts
    .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

function plainText(m: ChatMessage): string {
  const invocation = m.parts
    .filter((p): p is Extract<MessagePart, { type: 'skill-invocation' }> => p.type === 'skill-invocation')
    .map((p) => `/${p.name}${p.args ? ` ${p.args}` : ''}`)
  return [...invocation, textOnly(m)].filter(Boolean).join('\n')
}

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation('chat')
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      title={t('messages.copy')}
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        })
      }}
      className="rounded p-1 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
    >
      {done ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )
}

function ResponseDuration({ message }: { message: ChatMessage }) {
  const { t } = useTranslation('chat')
  const [, tick] = useState(0)
  const live = message.responseStartedAt != null && message.responseDurationMs == null
  useEffect(() => {
    if (!live) return
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [live])
  const duration =
    message.responseDurationMs ??
    (message.responseStartedAt != null ? responseDurationMs(message.responseStartedAt) : undefined)
  if (duration == null) return null
  return (
    <span
      title={t('messages.responseTime', { duration: formatResponseDuration(duration) })}
      className="font-mono text-[11px] tabular-nums text-muted-foreground/70"
    >
      {formatResponseDuration(duration)}
    </span>
  )
}

const fmtReviewLoopCost = (c: number): string =>
  c >= 1 ? `$${c.toFixed(2)}` : c >= 0.01 ? `$${c.toFixed(3)}` : `$${c.toFixed(4)}`

type ReviewLoopRoundStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

function reviewLoopRoundStatus(message: ChatMessage): ReviewLoopRoundStatus {
  if (message.errorCode === 'review-loop-process-interrupted') return 'interrupted'
  if (message.error) return 'failed'
  if (message.finishReason === 'aborted') return 'cancelled'

  if (message.finishReason != null && CUT_FINISH_REASONS.has(message.finishReason)) return 'failed'
  if (message.finishReason != null || message.responseDurationMs != null) return 'completed'
  return 'running'
}

function ReviewLoopRoundChrome({
  message,
  collapsed,
  onToggle,
}: {
  message: ChatMessage
  collapsed: boolean
  onToggle?: () => void
}) {
  const { t } = useTranslation('chat')

  const [metaByModel, setMetaByModel] = useState<Record<string, ChatModelMeta | null>>({})
  const metaByModelRef = useRef(metaByModel)
  metaByModelRef.current = metaByModel
  const modelPairsKey = useMemo(() => {
    const pairs = new Map<string, [string, string]>()
    const parentModel = message.model?.modelId
    if (parentModel) pairs.set(`${message.model!.providerId}\0${parentModel}`, [message.model!.providerId, parentModel])
    for (const s of message.usage?.subagentUsage ?? []) {
      if (!s.modelId) continue
      pairs.set(`${s.providerId}\0${s.modelId}`, [s.providerId, s.modelId])
    }
    return JSON.stringify(
      [...pairs.values()].sort(([pa, ma], [pb, mb]) => pa.localeCompare(pb) || ma.localeCompare(mb))
    )
  }, [message.model, message.usage])
  useEffect(() => {
    const pairs = JSON.parse(modelPairsKey) as Array<[string, string]>
    const missing = pairs.filter(([providerId, modelId]) => !(`${providerId}\0${modelId}` in metaByModelRef.current))
    if (missing.length === 0) return
    let alive = true
    Promise.all(
      missing.map(([providerId, modelId]) =>
        window.api
          .chatModelMeta(modelId, providerId || undefined)
          .then((mm) => [`${providerId}\0${modelId}`, mm] as const)
      )
    ).then((loaded) => {
      if (alive) setMetaByModel((prev) => ({ ...prev, ...Object.fromEntries(loaded) }))
    })
    return () => {
      alive = false
    }
  }, [modelPairsKey])

  const modelId = message.model?.modelId
  const status = reviewLoopRoundStatus(message)
  const loop = message.reviewLoop
  const isPaired = message.source === 'maestrly-review-loop'
  const isSummary = (message.source === 'chatgpt-web-review-loop' || message.source === 'maestrly-review-loop') && !loop

  const cost =
    message.usage != null
      ? estimatedCostOfUsageWithSubagents(message.usage, message.model, (pid, mid) => {
          const mm = metaByModelRef.current[`${pid}\0${mid}`]
          return mm !== undefined ? mm : null
        })
      : null

  const duration =
    message.responseDurationMs ??
    (message.responseStartedAt != null ? responseDurationMs(message.responseStartedAt) : undefined)

  const statusKey =
    status === 'running'
      ? 'reviewLoopStatusRunning'
      : status === 'failed'
        ? 'reviewLoopStatusFailed'
        : status === 'cancelled'
          ? 'reviewLoopStatusCancelled'
          : status === 'interrupted'
            ? 'reviewLoopStatusInterrupted'
            : 'reviewLoopStatusCompleted'

  const statusClass =
    status === 'failed'
      ? 'border-red-500/30 bg-red-500/10 text-red-200'
      : status === 'cancelled' || status === 'interrupted'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
        : status === 'running'
          ? 'border-sky-500/30 bg-sky-500/10 text-sky-200'
          : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'

  const headerClass =
    status === 'failed'
      ? 'border-red-500/25 bg-red-500/[0.06]'
      : status === 'cancelled' || status === 'interrupted'
        ? 'border-amber-500/25 bg-amber-500/[0.06]'
        : 'border-white/[0.08] bg-white/[0.03]'

  return (
    <div className={cn('flex w-full min-w-0 flex-col gap-1.5 rounded-lg border px-2.5 py-1.5', headerClass)}>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px]">
        {onToggle && (
          <button
            type="button"
            onClick={onToggle}
            className="inline-flex shrink-0 items-center rounded p-0.5 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
            title={collapsed ? t('chatgptWeb.reviewLoopExpandRound') : t('chatgptWeb.reviewLoopCollapseRound')}
            aria-expanded={!collapsed}
          >
            <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', !collapsed && 'rotate-90')} />
          </button>
        )}
        <span className="font-medium text-foreground/90">
          {isSummary
            ? t('chatgptWeb.reviewLoopSummaryBadge')
            : isPaired && loop?.role
              ? `${t(`reviewLoop.role${loop.role === 'executor' ? 'Executor' : 'Reviewer'}`)} · ${t(
                  'reviewLoop.round',
                  {
                    iteration: loop.iteration,
                    max: loop.maxIterations,
                  }
                )}`
              : t('chatgptWeb.reviewLoopRoundHeader', { iteration: loop?.iteration ?? 0 })}
        </span>
        {modelId && (
          <span className="max-w-[160px] truncate font-mono text-[10px] text-muted-foreground" title={modelId}>
            {modelId}
          </span>
        )}
        {!isSummary && (
          <span
            className={cn('rounded border px-1.5 py-px text-[10px] font-medium uppercase tracking-wide', statusClass)}
          >
            {t(`chatgptWeb.${statusKey}`)}
          </span>
        )}
        {duration != null && (
          <span className="font-mono tabular-nums text-muted-foreground/80">{formatResponseDuration(duration)}</span>
        )}
        {cost != null && (
          <span
            className="font-mono tabular-nums text-muted-foreground/80"
            title={t('chatgptWeb.reviewLoopCostEstimate', { cost: fmtReviewLoopCost(cost) })}
          >
            ~{fmtReviewLoopCost(cost)}
          </span>
        )}
      </div>
    </div>
  )
}

function Reasoning({ text, onOpenMention, searchQuery, currentSearchMatch }: SearchableTextProps) {
  if (!text.trim()) return null
  return (
    <div className="min-w-0 max-w-full rounded-lg border border-white/[0.06] bg-white/[0.015] px-3 py-2 text-[13px] italic text-muted-foreground">
      <MarkdownViewer
        markdown={text}
        onOpenMention={onOpenMention}
        searchQuery={searchQuery}
        currentSearchMatch={currentSearchMatch}
      />
    </div>
  )
}

interface SearchableTextProps {
  text: string
  onOpenMention?: OpenFileReference
  searchQuery?: string
  currentSearchMatch?: boolean
}

function Compaction({
  text,
  native = false,
  onOpenMention,
  searchQuery,
  currentSearchMatch,
}: SearchableTextProps & { native?: boolean }) {
  const { t } = useTranslation('chat')
  return (
    <div className="my-1 flex min-w-0 max-w-full flex-col gap-2">
      <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
        <span className="h-px flex-1 bg-white/[0.1]" />
        {t('messages.compacted')}
        <span className="h-px flex-1 bg-white/[0.1]" />
      </div>
      {native ? (
        <div className="min-w-0 max-w-full rounded-lg border border-white/[0.06] bg-white/[0.015] px-3 py-2 text-[12px] text-muted-foreground/80">
          {t('messages.nativeContextCheckpoint')}
        </div>
      ) : (
        <details className="min-w-0 max-w-full rounded-lg border border-white/[0.06] bg-white/[0.015] px-3 py-2">
          <summary className="cursor-pointer select-none text-[12px] text-muted-foreground/80 hover:text-foreground">
            {t('messages.previousContextSummary')}
          </summary>
          <div className="mt-2 text-[13px] text-muted-foreground">
            <MarkdownViewer
              markdown={text}
              onOpenMention={onOpenMention}
              searchQuery={searchQuery}
              currentSearchMatch={currentSearchMatch}
            />
          </div>
        </details>
      )}
    </div>
  )
}

function ContextImport({
  text,
  source,
  onOpenMention,
  searchQuery,
  currentSearchMatch,
}: SearchableTextProps & { source?: string }) {
  const { t } = useTranslation('chat')
  return (
    <div className="my-1 flex min-w-0 max-w-full flex-col gap-2">
      <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
        <span className="h-px flex-1 bg-white/[0.1]" />
        {t('messages.contextImported')}
        {source ? ` · ${source}` : ''}
        <span className="h-px flex-1 bg-white/[0.1]" />
      </div>
      <details className="min-w-0 max-w-full rounded-lg border border-white/[0.06] bg-white/[0.015] px-3 py-2">
        <summary className="cursor-pointer select-none text-[12px] text-muted-foreground/80 hover:text-foreground">
          {t('messages.historyFrom', { source: source ?? t('messages.otherTool') })}
        </summary>
        <div className="mt-2 text-[13px] text-muted-foreground">
          <MarkdownViewer
            markdown={text}
            onOpenMention={onOpenMention}
            searchQuery={searchQuery}
            currentSearchMatch={currentSearchMatch}
          />
        </div>
      </details>
    </div>
  )
}

function SkillChip({ name, args, dir }: { name: string; args?: string; dir?: string }) {
  const { t } = useTranslation('chat')
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span
        title={dir ? t('messages.skillFolder', { dir }) : undefined}
        className="inline-flex items-center gap-1 rounded-md border border-violet-400/25 bg-violet-400/[0.14] px-1.5 py-0.5 font-mono text-[13px] text-violet-200"
      >
        <Sparkles className="h-3 w-3" />/{name}
      </span>
      {args && <span className="min-w-0 break-words text-[13px] text-foreground">{args}</span>}
    </div>
  )
}

function Part({
  part,
  latestTodoId,
  conversationId,
  messageId,
  onOpenImage,
  onOpenMention,
  searchQuery,
  currentSearchMatch,
}: {
  part: MessagePart
  latestTodoId: string | null

  conversationId: string
  messageId: string
  onOpenImage?: (src: string, name: string) => void
  onOpenMention?: OpenFileReference
  searchQuery?: string
  currentSearchMatch?: boolean
}) {
  if (part.type === 'text') {
    if (part.checkpoint === 'openai-native')
      return (
        <Compaction
          text={part.text}
          native
          onOpenMention={onOpenMention}
          searchQuery={searchQuery}
          currentSearchMatch={currentSearchMatch}
        />
      )
    if (!part.text) return null
    return (
      <MarkdownViewer
        markdown={part.text}
        onOpenMention={onOpenMention}
        searchQuery={searchQuery}
        currentSearchMatch={currentSearchMatch}
      />
    )
  }
  if (part.type === 'reasoning')
    return (
      <Reasoning
        text={part.text}
        onOpenMention={onOpenMention}
        searchQuery={searchQuery}
        currentSearchMatch={currentSearchMatch}
      />
    )
  if (part.type === 'file') return null
  if (part.type === 'compaction')
    return (
      <Compaction
        text={part.text}
        native={
          part.strategy === 'openai-native' ||
          part.strategy === 'codex-native' ||
          part.strategy === 'claude-native'
        }
        onOpenMention={onOpenMention}
        searchQuery={searchQuery}
        currentSearchMatch={currentSearchMatch}
      />
    )
  if (part.type === 'context')
    return (
      <ContextImport
        text={part.text}
        source={part.source}
        onOpenMention={onOpenMention}
        searchQuery={searchQuery}
        currentSearchMatch={currentSearchMatch}
      />
    )
  if (part.type === 'generated-image')
    return (
      <GeneratedImageCard part={part} conversationId={conversationId} messageId={messageId} onOpenImage={onOpenImage} />
    )

  if (part.type === 'skill-invocation') return <SkillChip name={part.name} args={part.args} dir={part.dir} />
  // Agent mentions are composer metadata and do not render inside message bubbles.
  if (part.type === 'agent-mention') return null
  if (part.type === 'tool') {
    const toolPart = part
    if (toolPart.toolName === 'ask_question') return <QuestionCard part={toolPart} />
    if (toolPart.toolName === 'todo_write')
      return toolPart.toolCallId === latestTodoId ? <TodoCard part={toolPart} /> : null
    if (toolPart.toolName === 'task' || toolPart.toolName === 'delegate')
      return (
        <SubagentCard
          part={toolPart}
          conversationId={conversationId}
          messageId={messageId}
          onOpenMention={onOpenMention}
        />
      )
    return <ToolCallCard part={toolPart} conversationId={conversationId} messageId={messageId} />
  }
  return null
}

interface EditCtx {
  editingId: string | null
  onStartEdit: (id: string, text: string) => void
  onCancelEdit: () => void
  onSubmitEdit: (id: string, payload: { text: string; agentMentions: StructuredAgentMentionDraft[] }) => void
}

function UserEditor({
  id,
  initial,
  mentions,
  agents,
  onCancel,
  onSubmit,
  onOpenMention,
}: {
  id: string
  initial: string
  mentions: StructuredAgentMentionDraft[]

  agents: SubagentAgentDto[] | null
  onCancel: () => void
  onSubmit: (id: string, payload: { text: string; agentMentions: StructuredAgentMentionDraft[] }) => void
  onOpenMention?: (path: string, startLine?: number, endLine?: number) => void
}) {
  const { t } = useTranslation('chat')
  const [text, setText] = useState(initial)
  const [draftMentions, setDraftMentions] = useState<StructuredAgentMentionDraft[]>(mentions)
  const editorRef = useRef<MentionEditorHandle>(null)

  const submit = () => {
    const { text: serialized, mentions: liveMentions } = editorRef.current?.serialize() ?? {
      text,
      mentions: draftMentions,
    }
    if (!serialized.trim()) return
    onSubmit(id, { text: serialized, agentMentions: liveMentions })
  }

  return (
    <div className="rounded-xl border border-white/[0.12] bg-white/[0.05] px-3.5 py-2.5">
      <MentionEditor
        ref={editorRef}
        value={text}
        onChange={setText}
        onMentionsChange={setDraftMentions}
        structuredAgentMentions={draftMentions}
        agents={agents}
        autoFocus
        placeholder={t('composer.placeholder')}
        className="max-h-[240px] w-full resize-none overflow-y-auto bg-transparent"
        maxHeight={240}
        onOpenMention={onOpenMention}
        onRequestSubmit={submit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            onCancel()
            return true
          }
          return false
        }}
      />
      <div className="mt-1.5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-white/10 px-2.5 py-1 text-[12px] text-muted-foreground hover:bg-white/5"
        >
          {t('messages.cancel')}
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!text.trim()}
          className="rounded-md bg-indigo-500 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-indigo-400 disabled:opacity-50"
        >
          {t('messages.send')}
        </button>
      </div>
    </div>
  )
}

function FileParts({
  files,
  onOpenImage,
  conversationId,
  messageId,
}: {
  files: Extract<MessagePart, { type: 'file' }>[]
  onOpenImage?: (src: string, name: string) => void
  conversationId: string
  messageId: string
}) {
  const { t } = useTranslation('chat')
  if (files.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {files.map((f) =>
        f.kind === 'image' ? (
          <span key={f.id} className="relative">
            <AttachmentImage part={f} conversationId={conversationId} messageId={messageId} onOpenImage={onOpenImage} />

            {f.description && (
              <span className="absolute bottom-0 right-0 flex items-center gap-0.5 rounded-tl bg-black/75 px-1 py-0.5 text-[9px] text-emerald-300">
                <ScanText className="h-2.5 w-2.5" />
                {t('messages.imageDescribedBadge')}
              </span>
            )}
          </span>
        ) : (
          <span
            key={f.id}
            className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[12px] text-foreground"
            title={f.name}
          >
            <FileText className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="max-w-[160px] truncate">{f.name}</span>
          </span>
        )
      )}
    </div>
  )
}

const Bubble = memo(function Bubble({
  message,
  canEdit,
  isEditing,
  latestTodoId,
  agents,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRetrySteering,
  onOpenMention,
  onOpenImage,
  searchQuery,
  currentSearchMatch,
}: {
  message: ChatMessage
  canEdit: boolean
  isEditing: boolean

  latestTodoId: string | null

  agents?: SubagentAgentDto[] | null
  onStartEdit: (id: string, text: string) => void
  onCancelEdit: () => void
  onSubmitEdit: (id: string, payload: { text: string; agentMentions: StructuredAgentMentionDraft[] }) => void
  onRetrySteering?: (text: string) => void
  onOpenMention?: (path: string, startLine?: number, endLine?: number) => void
  onOpenImage?: (src: string, name: string) => void
  searchQuery?: string
  currentSearchMatch?: boolean
}) {
  const { t } = useTranslation('chat')
  const { openSettings } = useSettings()
  const isUser = message.role === 'user'
  const text = plainText(message)
  const bodyText = textOnly(message)

  const files = message.parts.filter((p): p is Extract<MessagePart, { type: 'file' }> => p.type === 'file' && !p.hidden)

  const skillInvocations = message.parts.filter(
    (p): p is Extract<MessagePart, { type: 'skill-invocation' }> => p.type === 'skill-invocation'
  )

  const hasAgentMentions = message.parts.some((p) => p.type === 'agent-mention')
  const catalogLoading = agents === null || agents === undefined
  const editBlockedByCatalog = hasAgentMentions && catalogLoading

  const isReviewLoopSource = message.source === 'chatgpt-web-review-loop' || message.source === 'maestrly-review-loop'
  const isReviewLoopRound = isReviewLoopSource && !!message.reviewLoop
  const roundStatus = isReviewLoopRound ? reviewLoopRoundStatus(message) : null

  const [roundCollapsed, setRoundCollapsed] = useState(() => isReviewLoopRound && roundStatus !== 'running')
  const [memoryExpanded, setMemoryExpanded] = useState(false)
  useEffect(() => {
    if (!isReviewLoopRound) return
    if (roundStatus === 'running') setRoundCollapsed(false)
  }, [isReviewLoopRound, roundStatus])

  if (isUser) {
    if (isEditing) {
      const editMentions: StructuredAgentMentionDraft[] = message.parts
        .filter((p): p is Extract<MessagePart, { type: 'agent-mention' }> => p.type === 'agent-mention')
        .filter((p) => typeof p.start === 'number' && typeof p.end === 'number')
        .map((p) => ({ id: p.id, name: p.name, start: p.start!, end: p.end! }))
      return (
        <UserEditor
          id={message.id}
          initial={text}
          mentions={editMentions}
          agents={agents ?? null}
          onCancel={onCancelEdit}
          onSubmit={onSubmitEdit}
          onOpenMention={onOpenMention}
        />
      )
    }
    return (
      <div className="group flex w-full min-w-0 max-w-full flex-col gap-1">
        <FileParts
          files={files}
          onOpenImage={onOpenImage}
          conversationId={message.conversationId}
          messageId={message.id}
        />
        {skillInvocations.map((p) => (
          <SkillChip key={p.id} name={p.name} args={p.args} dir={p.dir} />
        ))}

        {bodyText.trim() && (
          <div className="whitespace-pre-wrap break-words rounded-xl border border-white/[0.06] bg-white/[0.05] px-3.5 py-2.5 text-[15px] leading-relaxed text-foreground">
            <MarkdownViewer
              markdown={bodyText}
              onOpenMention={onOpenMention}
              searchQuery={searchQuery}
              currentSearchMatch={currentSearchMatch}
            />
          </div>
        )}
        {message.steering && (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>
              {message.steering.status === 'failed'
                ? t('messages.steeringFailed', { defaultValue: 'Not applied to the active turn.' })
                : t('messages.steeringQueued', { defaultValue: 'Queued into the active turn.' })}
            </span>
            {message.steering.status === 'failed' && onRetrySteering && (
              <button
                type="button"
                onClick={() => onRetrySteering(text)}
                className="rounded border border-white/10 px-1.5 py-0.5 text-foreground hover:bg-white/[0.06]"
              >
                {t('messages.steeringRetry', { defaultValue: 'Queue retry' })}
              </button>
            )}
          </div>
        )}
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <CopyButton text={text} />
          {canEdit && (
            <button
              type="button"
              title={
                editBlockedByCatalog
                  ? t('messages.editResendLoading', { defaultValue: 'Loading agents…' })
                  : t('messages.editResend')
              }
              disabled={editBlockedByCatalog}
              onClick={() => {
                if (editBlockedByCatalog) return
                onStartEdit(message.id, text)
              }}
              className="rounded p-1 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    )
  }

  const wasCut = !message.error && message.finishReason != null && CUT_FINISH_REASONS.has(message.finishReason)
  const showRoundBody = !isReviewLoopRound || !roundCollapsed
  const delegateParts = message.parts.filter(
    (part): part is Extract<MessagePart, { type: 'tool' }> => part.type === 'tool' && part.toolName === 'delegate'
  )
  const firstDelegateId = delegateParts[0]?.toolCallId

  const body = (
    <>
      {message.memoryContext && message.memoryContext.sources.length > 0 && (
        <div className="w-fit max-w-full">
          <button
            type="button"
            onClick={() => setMemoryExpanded((value) => !value)}
            className="flex items-center gap-1.5 rounded-full border border-fuchsia-400/25 bg-fuchsia-400/[0.08] px-2 py-0.5 text-[10px] font-medium text-fuchsia-200 hover:bg-fuchsia-400/[0.13]"
            title={t('messages.memorySourcesHint')}
          >
            <BrainCircuit className="size-3" />
            {t('messages.memoriesUsed', { count: message.memoryContext.sources.length })}
          </button>
          {memoryExpanded && (
            <div className="mt-1.5 max-w-lg space-y-1 rounded-lg border border-white/[0.08] bg-black/20 p-1.5">
              {message.memoryContext.sources.map((source, index) => (
                <button
                  key={`${source.kind}:${source.id}:${source.path ?? ''}:${index}`}
                  type="button"
                  onClick={() => {
                    if (source.kind === 'local') {
                      window.dispatchEvent(
                        new CustomEvent('maestrly:open-memory', {
                          detail: { conversationId: message.conversationId, memoryId: source.id },
                        })
                      )
                      return
                    }
                    if (!source.path) return
                    const publicRepo =
                      source.repo &&
                      source.repo !== 'repository' &&
                      !source.repo.includes('/') &&
                      !source.repo.includes('\\') &&
                      !source.repo.includes(':')
                        ? `${source.repo}/`
                        : ''
                    onOpenMention?.(`${publicRepo}${source.path}`, source.startLine, source.endLine)
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[10px] text-muted-foreground hover:bg-white/[0.05] hover:text-foreground"
                >
                  <span className="rounded bg-white/[0.06] px-1 py-0.5">
                    {source.kind === 'local' ? t('messages.memoryLocal') : t('messages.memoryShared')}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{source.title}</span>
                  {source.path && <span className="max-w-48 truncate font-mono opacity-70">{source.path}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {message.parts.map((p, i) =>
        p.type === 'tool' && p.toolName === 'delegate' ? (
          p.toolCallId === firstDelegateId ? (
            <OrchestrationRun
              key="maestro-orchestration-run"
              parts={delegateParts}
              conversationId={message.conversationId}
              messageId={message.id}
              onOpenMention={onOpenMention}
            />
          ) : null
        ) : (
          <Part
            key={p.type === 'tool' ? p.toolCallId : `${p.type}-${i}`}
            part={p}
            latestTodoId={latestTodoId}
            conversationId={message.conversationId}
            messageId={message.id}
            onOpenImage={onOpenImage}
            onOpenMention={onOpenMention}
            searchQuery={searchQuery}
            currentSearchMatch={currentSearchMatch}
          />
        )
      )}
      {message.error && (
        <div
          role={
            message.errorCode === 'claude-authentication-required' ||
            subscriptionExhaustionMessageKey(message.errorCode) ||
            message.errorCode === 'review-loop-process-interrupted'
              ? 'alert'
              : undefined
          }
          className="flex min-w-0 max-w-full flex-col items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-[14px] text-red-300"
        >
          <span>
            {message.errorCode === 'review-loop-process-interrupted'
              ? t('chatgptWeb.reviewLoopProcessInterruptedError')
              : message.errorCode === 'claude-authentication-required'
                ? t('messages.claudeAuthenticationRequired')
                : subscriptionExhaustionMessageKey(message.errorCode)
                  ? t(subscriptionExhaustionMessageKey(message.errorCode)!)
                  : message.error}
          </span>
          {message.errorCode === 'claude-authentication-required' && (
            <button
              type="button"
              onClick={() => openSettings('chat')}
              className="rounded-md border border-red-300/30 bg-red-300/10 px-2.5 py-1.5 text-[12px] font-medium text-red-100 hover:bg-red-300/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300/70"
            >
              {t('messages.manageClaudeConnection')}
            </button>
          )}
        </div>
      )}
      {wasCut && (
        <div className="flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/[0.08] px-3 py-1.5 text-[12px] text-amber-200/90">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
          {t('messages.interrupted')}
        </div>
      )}
      {(text.trim() ||
        (!isReviewLoopSource && (message.responseDurationMs != null || message.responseStartedAt != null))) && (
        <div className="flex items-center gap-1.5">
          <div className="opacity-0 transition-opacity group-hover:opacity-100">
            {text.trim() && <CopyButton text={text} />}
          </div>
          {!isReviewLoopSource && <ResponseDuration message={message} />}
        </div>
      )}
    </>
  )

  return (
    <div className="group flex w-full min-w-0 max-w-full flex-col gap-2.5">
      {message.source === 'chatgpt-web' && (
        <div className="w-fit rounded-full border border-violet-400/25 bg-violet-400/[0.08] px-2 py-0.5 text-[10px] font-medium text-violet-200">
          ChatGPT Web
        </div>
      )}
      {isReviewLoopSource && (
        <ReviewLoopRoundChrome
          message={message}
          collapsed={roundCollapsed}
          onToggle={isReviewLoopRound ? () => setRoundCollapsed((v) => !v) : undefined}
        />
      )}
      {showRoundBody && body}
    </div>
  )
})

interface Props extends EditCtx {
  messages: ChatMessage[]

  readOnly?: boolean
  experience?: ConversationExperience
  streaming: boolean
  visible: boolean

  agents?: SubagentAgentDto[] | null

  onOpenMention?: OpenFileReference

  scrollContainerRef?: RefObject<HTMLDivElement | null>
  /** Prepend older messages when scrolling to the top and return the count added. */
  onLoadOlder?: () => Promise<number>

  hasMore?: boolean

  highlightMsgId?: string | null

  searchQuery?: string

  searchHitIds?: ReadonlySet<string>

  currentSearchHitId?: string | null
  onRetrySteering?: (text: string) => void
}

export const ChatMessageList = memo(function ChatMessageList({
  messages,
  experience = 'standard',
  streaming,
  visible,
  agents,
  onOpenMention,
  editingId,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  scrollContainerRef,
  onLoadOlder,
  hasMore,
  highlightMsgId,
  searchQuery,
  searchHitIds,
  currentSearchHitId,
  readOnly = false,
  onRetrySteering,
}: Props) {
  const { t } = useTranslation('chat')
  const [lightbox, setLightbox] = useState<{ src: string; name: string } | null>(null)

  const openImage = useCallback((src: string, name: string) => setLightbox({ src, name }), [])
  const closeImage = useCallback(() => setLightbox(null), [])

  const visibleMessages = useMemo(() => messages.filter((m) => !m.internal), [messages])

  const last = visibleMessages.length ? visibleMessages[visibleMessages.length - 1] : null
  const lastMarker = last
    ? last.parts
        .map((p) => {
          if (p.type === 'text' || p.type === 'reasoning' || p.type === 'compaction' || p.type === 'context')
            return `${p.type}:${p.text.length}`
          if (p.type === 'file') return `file:${p.kind}:${p.hidden ? 'h' : 'v'}:${p.name.length}`

          if (p.type === 'generated-image') return `img:${p.id}:${p.artifactId}`
          if (p.type === 'skill-invocation') return `skill:${p.name}:${p.args?.length ?? 0}`
          if (p.type === 'agent-mention') return `agent-mention:${p.name}`
          const out =
            p.state.status === 'completed'
              ? toolOutputText(p.state.output).length
              : p.state.status === 'error'
                ? p.state.error.length
                : p.state.status === 'denied'
                  ? (p.state.reason?.length ?? 0)
                  : p.state.status === 'running'
                    ? toolOutputText(p.state.output).length // Follow live task output as the card grows.
                    : 0
          return `tool:${p.toolCallId}:${p.toolName}:${p.state.status}:${out}`
        })
        .join('|')
    : ''

  let lastUserId: string | null = null
  for (let i = visibleMessages.length - 1; i >= 0; i--) {
    if (visibleMessages[i].role === 'user') {
      lastUserId = visibleMessages[i].id
      break
    }
  }

  let latestTodoId: string | null = null
  for (const m of visibleMessages)
    for (const p of m.parts)
      if (p.type === 'tool' && p.toolName === 'todo_write') latestTodoId = p.toolCallId

  const nearBottomRef = useRef(true)
  const prevVisibleRef = useRef(false)

  const postSendScrollRafRef = useRef<number | null>(null)

  const anchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null)
  const firstIdRef = useRef<string | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  const triggerLoadOlder = useCallback(async () => {
    const el = scrollContainerRef?.current
    if (!el || anchorRef.current || !onLoadOlder) return
    anchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop }
    let added = 0
    try {
      added = await onLoadOlder()
    } catch {
      added = 0
    }

    if (!added) anchorRef.current = null
  }, [scrollContainerRef, onLoadOlder])

  useEffect(() => {
    const el = scrollContainerRef?.current
    if (!el) return
    const onScroll = () => {
      nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      if (el.scrollTop < 240 && hasMore) void triggerLoadOlder()
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [scrollContainerRef, hasMore, triggerLoadOlder])

  useLayoutEffect(() => {
    const becameVisible = visible && !prevVisibleRef.current
    prevVisibleRef.current = visible
    if (!visible) {
      if (postSendScrollRafRef.current !== null) cancelAnimationFrame(postSendScrollRafRef.current)
      postSendScrollRafRef.current = null
      return
    }
    if (anchorRef.current) return
    const el = scrollContainerRef?.current
    if (!el) return
    if (visibleMessages[visibleMessages.length - 1]?.role === 'user') {
      nearBottomRef.current = true
      if (postSendScrollRafRef.current !== null) cancelAnimationFrame(postSendScrollRafRef.current)
      postSendScrollRafRef.current = requestAnimationFrame(() => {
        postSendScrollRafRef.current = null
        const currentEl = scrollContainerRef?.current
        if (!currentEl || anchorRef.current) return
        currentEl.scrollTop = currentEl.scrollHeight
        nearBottomRef.current = true
      })
    }
    if (becameVisible || nearBottomRef.current) el.scrollTop = el.scrollHeight
  }, [visibleMessages, lastMarker, visible, scrollContainerRef])

  useEffect(
    () => () => {
      if (postSendScrollRafRef.current !== null) cancelAnimationFrame(postSendScrollRafRef.current)
    },
    []
  )

  useEffect(() => {
    const content = contentRef.current
    const scroller = scrollContainerRef?.current
    if (!content || !scroller || typeof ResizeObserver === 'undefined') return
    let frame = 0
    const observer = new ResizeObserver(() => {
      if (!visible || anchorRef.current || !nearBottomRef.current) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (visible && !anchorRef.current && nearBottomRef.current) scroller.scrollTop = scroller.scrollHeight
      })
    })
    observer.observe(content)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [scrollContainerRef, visible])

  useLayoutEffect(() => {
    const el = scrollContainerRef?.current
    const firstId = messages.length ? messages[0].id : null
    if (anchorRef.current && el && firstId !== firstIdRef.current) {
      el.scrollTop = anchorRef.current.scrollTop + (el.scrollHeight - anchorRef.current.scrollHeight)
      anchorRef.current = null
    }
    firstIdRef.current = firstId
  }, [messages])

  if (visibleMessages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[14px] text-muted-foreground">
        <div className="max-w-sm">
          <p className="text-[15px] font-medium text-foreground">
            {experience === 'maestro' ? 'Maestro' : 'Maestrly Chat'}
          </p>
          <p className="mt-1.5">
            {experience === 'maestro' ? t('messages.maestroEmptyState') : t('messages.emptyState')}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div ref={contentRef} className="chat-msgs mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-5 px-3 py-5">
      {lightbox && <ChatImageLightbox src={lightbox.src} name={lightbox.name} onClose={closeImage} />}
      {visibleMessages.map((m, i) => (
        // Keep the scroll anchor stable while content visibility updates card height.

        <div
          key={m.id}
          data-msg-id={m.id}
          className={cn(
            'min-w-0 max-w-full scroll-mt-16 rounded-xl transition-shadow',
            highlightMsgId === m.id && 'ring-2 ring-sky-400/60 ring-offset-2 ring-offset-[#0d0d10]'
          )}
          style={
            i < visibleMessages.length - 1
              ? ({ contentVisibility: 'auto', containIntrinsicSize: 'auto 360px' } as CSSProperties)
              : ({ containIntrinsicSize: 'auto 360px' } as CSSProperties)
          }
        >
          <Bubble
            message={m}
            canEdit={!readOnly && !streaming && m.id === lastUserId}
            isEditing={editingId === m.id}
            latestTodoId={latestTodoId}
            agents={agents}
            onStartEdit={onStartEdit}
            onCancelEdit={onCancelEdit}
            onSubmitEdit={onSubmitEdit}
            onRetrySteering={onRetrySteering}
            onOpenMention={onOpenMention}
            onOpenImage={openImage}
            searchQuery={searchHitIds?.has(m.id) ? searchQuery : undefined}
            currentSearchMatch={currentSearchHitId === m.id}
          />
        </div>
      ))}
      {streaming && (
        <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground" />
          {t('messages.generating')}
        </div>
      )}
    </div>
  )
})
