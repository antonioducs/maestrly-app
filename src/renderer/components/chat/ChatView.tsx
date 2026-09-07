/** Conversation host for provider streams, queued turns, draft attachments, and paginated history.
 * Bound hidden rendering work while preserving session state and reconciling on visibility changes. */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import { X, Pencil, ArrowDown } from 'lucide-react'
import { scrollChatSearchResult } from '@/lib/chat-search-scroll'
import { subscribeSubagentProfilesChanged } from '@/lib/subagent-catalog-events'
import { cn } from '@/lib/utils'
import {
  applyChatEvent,
  CHAT_SUBSCRIPTION_PROVIDER_KINDS,
  contextOccupancy,
  DEFAULT_REASONING_EFFORTS,
  findPendingChatQuestion,
  isMaestrlyUltraEffort,
  isChatProviderConnected,
  isReviewLoopConversationReserved,
  MAESTRLY_ULTRA_EFFORT,
  mergePendingChatQuestions,
  nextQuickReasoningEffort,
  parseSlashInvocation,
} from '../../../shared/chat'
import type {
  ChatHistoryStats,
  ChatMessage,
  ChatMode,
  ChatModelMeta,
  ChatPermissionRequest,
  PendingChatQuestion,
  ChatProjectCommand,
  ChatReasoningEffort,
  ChatSearchHit,
  ChatSkillCommand,
  ChatSlashCommand,
  ChatStreamEvent,
  ChatSubscriptionFailoverEvent,
  ChatConfig,
  ChatActiveHarnessProfile,
  ChatUserPrompt,
  MessagePart,
  ReviewLoopInfo,
  SubagentSessionSummary,
} from '../../../shared/chat'
import type { SubagentAgentDto } from '../../../shared/subagent-profiles'
import type { ConversationExperience } from '../../../shared/conversation-experience'
import type { MaestroLiveEvent, MaestroLiveState } from '../../../shared/maestro-live'
import {
  shouldReloadOnUserSaved,
  validateStructuredAgentMentions,
  type StructuredAgentMentionDraft,
} from '../../../shared/chat-agent-mentions'

import { ChatMessageList } from './ChatMessageList'
import { boundChatHistoryWindow, CHAT_HISTORY_PAGE_SIZE as HISTORY_PAGE_SIZE } from '@/lib/chat-history-window'
import { boundDraftAttachments } from '@/lib/draft-attachment-budget'
import {
  MAX_ATTACHMENT_IMAGE_BYTES,
  MAX_ATTACHMENT_IMAGES_PER_MESSAGE,
  MAX_ATTACHMENT_IMAGE_BYTES_PER_MESSAGE,
  MAX_ATTACHMENT_TEXT_BYTES,
} from '../../../shared/memory-policy'
import { ChatSearchBar } from './ChatSearchBar'
import { ChatComposer, type ChatComposerHandle, type UIAttachment } from './ChatComposer'
import { QuestionComposer } from './QuestionComposer'
import { PermissionPrompt } from './PermissionPrompt'
import { ChatModelChip, type ChatModelChipHandle } from './ChatModelChip'
import { ChatPermModePicker } from './ChatPermModePicker'
import { ChatModePicker } from './ChatModePicker'
import { ChatSkillsMenu } from './ChatSkillsMenu'
import { ChatReasoningPicker } from './ChatReasoningPicker'
import { ChatFastModeToggle } from './ChatFastModeToggle'
import { ChatPlusMenu } from './ChatPlusMenu'
import { ChatContextMeter } from './ChatContextMeter'
import { ChatMicButton } from './ChatMicButton'
import { ChatGptWebSessionBanner } from './ChatGptWebSessionBanner'
import { ReviewLoopBanner } from './ReviewLoopBanner'
import { MaestroControl } from './MaestroControl'
import { MaestroActivityPill, type MaestroRun } from './MaestroActivityPill'
import type { DelegatePart } from './OrchestrationRun'
import { SubagentSessionPanel } from './SubagentSessionPanel'
import { SubagentSessionContext, SubagentSessionsContext, type OpenSubagentSession } from './SubagentSessionContext'
import { SubagentActivityPill } from './SubagentActivityPill'
import { routeAstraComposerSubmit, routeAstraReasoningChange } from './astra-turn-controls'

interface Props {
  conversationId: string
  cwd: string
  experience: ConversationExperience
  onExperienceChange?: (conversationId: string, experience: ConversationExperience) => void
  visible: boolean

  status?: string

  onEvictionSafetyChange?: (conversationId: string, safeToEvict: boolean) => void
}

interface QueuedMsg {
  id: string
  text: string
  attachments: UIAttachment[]

  agentMentions: StructuredAgentMentionDraft[]

  maestroLive?: { runId: string; messageId: string }
}

function revokeAttachmentPreview(attachment: UIAttachment): void {
  if (attachment.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(attachment.previewUrl)
}

function revokeAttachmentPreviews(attachments: readonly UIAttachment[]): void {
  for (const attachment of attachments) revokeAttachmentPreview(attachment)
}

export function ChatView({
  conversationId,
  cwd: _cwd,
  experience,
  onExperienceChange,
  visible,
  status,
  onEvictionSafetyChange,
}: Props) {
  const { t } = useTranslation('chat')
  const [currentExperience, setCurrentExperience] = useState(experience)
  useEffect(() => setCurrentExperience(experience), [conversationId, experience])
  const isMaestro = currentExperience === 'maestro'
  const maestroPanelHostId = `chat-maestro-panel-${conversationId}`
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [subagentSessions, setSubagentSessions] = useState<SubagentSessionSummary[]>([])
  const [selectedSubagentSessionId, setSelectedSubagentSessionId] = useState<string | null>(null)
  const [subagentPaneWidth, setSubagentPaneWidth] = useState(42)
  const rootRef = useRef<HTMLDivElement>(null)

  const [hasMore, setHasMore] = useState(false)
  const [historyStats, setHistoryStats] = useState<ChatHistoryStats | null>(null)
  const earliestSeqRef = useRef<number | null>(null)
  const anchoredRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<ChatComposerHandle>(null)
  const modelChipRef = useRef<ChatModelChipHandle>(null)
  const [atBottom, setAtBottom] = useState(true)
  // Chat search (Cmd/Ctrl+F).
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchHits, setSearchHits] = useState<ChatSearchHit[]>([])
  const [searchResultQuery, setSearchResultQuery] = useState('')
  const [searchIndex, setSearchIndex] = useState(-1)
  const [searchLoading, setSearchLoading] = useState(false)
  const [highlightMsgId, setHighlightMsgId] = useState<string | null>(null)
  const [streaming, setStreaming] = useState(() => status === 'working' || status === 'asking')
  const [stopPending, setStopPending] = useState(false)
  const [pending, setPending] = useState<ChatPermissionRequest[]>([])
  const [runtimeQuestions, setRuntimeQuestions] = useState<PendingChatQuestion[]>([])
  const [keyMissing, setKeyMissing] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const editingIdRef = useRef(editingId)
  editingIdRef.current = editingId
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  const runtimeQuestionsRef = useRef(runtimeQuestions)
  runtimeQuestionsRef.current = runtimeQuestions

  const runtimeQuestionRevisionRef = useRef(0)
  const setRuntimeQuestionState = useCallback(
    (next: PendingChatQuestion[] | ((current: PendingChatQuestion[]) => PendingChatQuestion[])) => {
      const resolved = typeof next === 'function' ? next(runtimeQuestionsRef.current) : next
      runtimeQuestionsRef.current = resolved
      setRuntimeQuestions(resolved)
    },
    []
  )

  const keepIdsFor = useCallback((): Set<string> => {
    const ids = new Set<string>()
    if (editingIdRef.current) ids.add(editingIdRef.current)
    for (const request of pendingRef.current) if (request.toolCallId) ids.add(request.toolCallId)
    for (const question of runtimeQuestionsRef.current) ids.add(question.messageId)
    return ids
  }, [])
  const [queue, setQueue] = useState<QueuedMsg[]>([])
  const [maestroLive, setMaestroLive] = useState<MaestroLiveState | null>(null)
  const [maestroSendTarget, setMaestroSendTarget] = useState<'current' | 'next'>('current')
  const [maestroPostPending, setMaestroPostPending] = useState(0)
  const [companionStarting, setCompanionStarting] = useState(false)

  const [failoverNotice, setFailoverNotice] = useState<string | null>(null)
  const [chatProviders, setChatProviders] = useState<ChatConfig['providers']>([])
  const [reviewLoop, setReviewLoop] = useState<ReviewLoopInfo | null>(null)
  const reviewLoopActive =
    reviewLoop != null &&
    (reviewLoop.driver === 'chatgpt-web'
      ? isReviewLoopConversationReserved(reviewLoop.status)
      : reviewLoop.status !== 'finished' && reviewLoop.status !== 'cancelled' && reviewLoop.status !== 'interrupted')
  const [draft, setDraft] = useState('')

  // Promoted attachments are handled by ChatComposer.
  const [draftMentions, setDraftMentions] = useState<StructuredAgentMentionDraft[]>([])
  const [attachments, setAttachments] = useState<UIAttachment[]>([])
  const attachmentsRef = useRef<UIAttachment[]>(attachments)
  attachmentsRef.current = attachments
  const [compacting, setCompacting] = useState(false)
  const [compactDismissed, setCompactDismissed] = useState(false)
  const [selModelId, setSelModelId] = useState<string | null>(null)
  const [selProviderId, setSelProviderId] = useState<string | null>(null)
  const [modelMeta, setModelMeta] = useState<ChatModelMeta | null>(null)
  const [modelRefresh, setModelRefresh] = useState(0)
  const [mode, setMode] = useState<ChatMode>('agent')
  const [reasoning, setReasoning] = useState<ChatReasoningEffort>('off')
  const [activeHarnessProfile, setActiveHarnessProfile] = useState<ChatActiveHarnessProfile | null>(null)
  const [midTurnSteering, setMidTurnSteering] = useState(false)
  const [liveReasoningUpdate, setLiveReasoningUpdate] = useState(false)

  const [subagents, setSubagents] = useState<SubagentAgentDto[] | null>(null)
  const [fontScale, setFontScaleState] = useState<number>(() => {
    const v = Number(localStorage.getItem('chat.fontScale'))
    return v >= 0.8 && v <= 1.6 ? v : 1
  })
  const setFontScale = useCallback((n: number) => {
    setFontScaleState(n)
    localStorage.setItem('chat.fontScale', String(n))
  }, [])

  const streamingRef = useRef(false)
  streamingRef.current = streaming
  const compactingRef = useRef(false)
  compactingRef.current = compacting
  const queueRef = useRef<QueuedMsg[]>(queue)
  const setQueueState = useCallback((next: QueuedMsg[] | ((current: QueuedMsg[]) => QueuedMsg[])) => {
    const resolved = typeof next === 'function' ? next(queueRef.current) : next
    queueRef.current = resolved
    setQueue(resolved)
  }, [])
  const maestroLiveRef = useRef<MaestroLiveState | null>(maestroLive)
  const maestroLiveRevisionRef = useRef(0)
  maestroLiveRef.current = maestroLive
  const applyMaestroLiveEvent = useCallback(
    (event: MaestroLiveEvent) => {
      maestroLiveRevisionRef.current += 1
      const changed =
        event.kind === 'message-posted' ? [event.message] : event.kind === 'messages-updated' ? event.messages : []
      if (changed.length > 0) {
        const terminalIds = new Set(
          changed
            .filter((message) => message.status === 'embedded' || message.status === 'cancelled')
            .map((message) => message.id)
        )
        if (terminalIds.size > 0) {
          setQueueState((current) =>
            current.filter((item) => !item.maestroLive || !terminalIds.has(item.maestroLive.messageId))
          )
        }
      }
      setMaestroLive((current) => {
        const run = event.run
        const base = current?.run.id === run.id ? current.messages : []
        const updates =
          event.kind === 'run-updated' ? [] : event.kind === 'message-posted' ? [event.message] : event.messages
        const byId = new Map(base.map((message) => [message.id, message]))
        for (const message of updates) byId.set(message.id, message)
        const next = { run, messages: [...byId.values()].sort((a, b) => a.seq - b.seq) }
        maestroLiveRef.current = next
        return next
      })
    },
    [setQueueState]
  )
  useEffect(
    () => window.api.onChatMaestroLive(conversationId, applyMaestroLiveEvent),
    [applyMaestroLiveEvent, conversationId]
  )
  useEffect(
    () => () => {
      revokeAttachmentPreviews(attachmentsRef.current)
      for (const item of queueRef.current) revokeAttachmentPreviews(item.attachments)
    },
    []
  )
  const stoppedRef = useRef(false)
  const convIdRef = useRef(conversationId)
  convIdRef.current = conversationId
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  const historyReloadRevisionRef = useRef(0)

  const messagePendingQuestion = useMemo(() => findPendingChatQuestion(messages), [messages])
  const pendingQuestion = messagePendingQuestion ?? runtimeQuestions.at(-1) ?? null

  const safeToEvict =
    draft.length === 0 &&
    draftMentions.length === 0 &&
    attachments.length === 0 &&
    queue.length === 0 &&
    !maestroPostPending &&
    pending.length === 0 &&
    editingId === null &&
    !companionStarting &&
    !compacting &&
    pendingQuestion === null &&
    status !== 'asking'
  useEffect(() => {
    onEvictionSafetyChange?.(conversationId, safeToEvict)
  }, [conversationId, onEvictionSafetyChange, safeToEvict])

  const refreshStats = useCallback(() => {
    void window.api.chatHistoryStats(conversationId).then((s) => {
      if (convIdRef.current === conversationId) setHistoryStats(s)
    })
  }, [conversationId])

  const normalizeHistoryWindow = useCallback(
    (
      prev: readonly ChatMessage[],
      incoming: readonly ChatMessage[],
      side: 'prepend' | 'replace',
      anchorId?: string
    ): ChatMessage[] => {
      const keepIds = keepIdsFor()
      if (anchorId) keepIds.add(anchorId)
      return boundChatHistoryWindow({ messages: prev, incoming, side, keepIds }).messages
    },
    []
  )

  const reloadLatestPage = useCallback(async () => {
    const revision = ++historyReloadRevisionRef.current
    const page = await window.api.chatHistoryPage(conversationId, { limit: HISTORY_PAGE_SIZE })
    if (convIdRef.current !== conversationId || revision !== historyReloadRevisionRef.current) return

    const hydrated = mergePendingChatQuestions(page.messages, conversationId, runtimeQuestionsRef.current)
    setMessages((prev) => normalizeHistoryWindow(prev, hydrated, 'replace', hydrated.at(-1)?.id))
    setHasMore(page.hasMore)
    earliestSeqRef.current = page.earliestSeq
    anchoredRef.current = false
    refreshStats()
  }, [conversationId, normalizeHistoryWindow, refreshStats])

  useEffect(
    () => window.api.onChatGptWebDelivery(conversationId, () => void reloadLatestPage()),
    [conversationId, reloadLatestPage]
  )
  useEffect(
    () => window.api.onChatReviewLoopDelivery(conversationId, () => void reloadLatestPage()),
    [conversationId, reloadLatestPage]
  )

  // Load older messages on demand and return the number prepended.

  const loadOlder = useCallback(async (): Promise<number> => {
    const cursor = earliestSeqRef.current
    if (cursor == null) return 0
    const page = await window.api.chatHistoryPage(conversationId, { beforeSeq: cursor, limit: HISTORY_PAGE_SIZE })
    if (convIdRef.current !== conversationId || page.messages.length === 0) {
      if (convIdRef.current === conversationId) setHasMore(false)
      return 0
    }
    earliestSeqRef.current = page.earliestSeq ?? cursor
    setHasMore(page.hasMore)
    setMessages((prev) => {
      const next = boundChatHistoryWindow({
        messages: prev,
        incoming: page.messages,
        side: 'prepend',
        keepIds: keepIdsFor(),
      })
      if (next.trimmedBack) anchoredRef.current = true
      return next.messages
    })
    return page.messages.length
  }, [conversationId, keepIdsFor])

  useEffect(() => {
    void reloadLatestPage()
  }, [reloadLatestPage])

  useEffect(() => {
    if (status !== 'working' && status !== 'asking') return
    if (!visibleRef.current) {
      streamingRef.current = true
      return
    }
    if (streamingRef.current) return
    streamingRef.current = true
    setStreaming(true)
  }, [status])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
    onScroll()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [conversationId])

  useEffect(() => {
    const el = scrollRef.current
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
  }, [messages.length])

  const scrollToBottom = useCallback(async () => {
    if (anchoredRef.current) {
      anchoredRef.current = false
      await reloadLatestPage()
    }
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: anchoredRef.current ? 'auto' : 'smooth' })
    })
  }, [reloadLatestPage])

  // --- Chat search (Cmd/Ctrl+F). -----------------------------------------------------------

  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchRequestRef = useRef(0)
  const searchNavigationRef = useRef(0)
  const searchScrollRafRef = useRef<number | null>(null)
  const cancelSearchNavigation = useCallback(() => {
    searchNavigationRef.current++
    if (searchScrollRafRef.current !== null) cancelAnimationFrame(searchScrollRafRef.current)
    searchScrollRafRef.current = null
  }, [])
  const flashHighlight = useCallback((id: string) => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    setHighlightMsgId(id)
    highlightTimerRef.current = setTimeout(() => setHighlightMsgId(null), 2500)
  }, [])

  const jumpToMessage = useCallback(
    (messageId: string) => {
      const el = scrollRef.current?.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(messageId)}"]`)
      if (!el) return
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      flashHighlight(messageId)
    },
    [flashHighlight]
  )

  const goToHit = useCallback(
    async (hit: ChatSearchHit) => {
      cancelSearchNavigation()
      const navigation = searchNavigationRef.current
      const reqConv = conversationId
      const isCurrent = () => convIdRef.current === reqConv && searchNavigationRef.current === navigation
      const present = !!scrollRef.current?.querySelector(`[data-msg-id="${CSS.escape(hit.messageId)}"]`)
      if (!present) {
        const page = await window.api.chatHistoryPage(conversationId, { aroundSeq: hit.seq, limit: HISTORY_PAGE_SIZE })
        if (!isCurrent()) return
        earliestSeqRef.current = page.earliestSeq
        setHasMore(page.hasMore)
        anchoredRef.current = !!page.hasMoreAfter

        setMessages((prev) => normalizeHistoryWindow(prev, page.messages, 'replace', hit.messageId))
      }
      if (!isCurrent()) return

      searchScrollRafRef.current = requestAnimationFrame(() => {
        searchScrollRafRef.current = null
        if (!isCurrent()) return
        const message = scrollRef.current?.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(hit.messageId)}"]`)
        if (!message) return
        const isRevealed = (match: HTMLElement) => {
          let details = match.closest('details')
          while (details) {
            if (!details.open) return false
            details = details.parentElement?.closest('details') ?? null
          }
          return true
        }
        scrollChatSearchResult(
          message.querySelectorAll<HTMLElement>('.chat-search-match--current'),
          message.querySelectorAll<HTMLElement>('.chat-search-match'),
          message,
          isRevealed
        )
        flashHighlight(hit.messageId)
      })
    },
    [cancelSearchNavigation, conversationId, flashHighlight, normalizeHistoryWindow]
  )

  useEffect(() => {
    if (!searchOpen) return
    const q = searchQuery.trim()
    if (!q) {
      searchRequestRef.current++
      cancelSearchNavigation()
      setSearchHits([])
      setSearchResultQuery('')
      setSearchIndex(-1)
      setSearchLoading(false)
      return
    }
    setSearchLoading(true)
    const reqConv = conversationId
    const request = ++searchRequestRef.current
    const handle = setTimeout(async () => {
      const hits = await window.api.chatSearchMessages(conversationId, q)
      if (convIdRef.current !== reqConv || searchRequestRef.current !== request) return
      setSearchHits(hits)
      setSearchResultQuery(q)
      setSearchLoading(false)
      if (hits.length > 0) {
        const idx = hits.length - 1 // Most recent.
        setSearchIndex(idx)
        void goToHit(hits[idx])
      } else {
        setSearchIndex(-1)
      }
    }, 180)
    return () => {
      clearTimeout(handle)
      if (searchRequestRef.current === request) searchRequestRef.current++
    }
  }, [searchQuery, searchOpen, conversationId, goToHit, cancelSearchNavigation])

  const searchHitIds = useMemo(() => new Set(searchHits.map((hit) => hit.messageId)), [searchHits])
  const currentSearchHitId = searchIndex >= 0 ? (searchHits[searchIndex]?.messageId ?? null) : null

  const searchIndexRef = useRef(-1)
  searchIndexRef.current = searchIndex
  const stepSearch = useCallback(
    (dir: 1 | -1) => {
      if (searchHits.length === 0) return
      const next = (searchIndexRef.current + dir + searchHits.length) % searchHits.length
      setSearchIndex(next)
      void goToHit(searchHits[next])
    },
    [searchHits, goToHit]
  )

  const changeSearchQuery = useCallback(
    (query: string) => {
      searchRequestRef.current++
      cancelSearchNavigation()
      setSearchQuery(query)
    },
    [cancelSearchNavigation]
  )

  const closeSearch = useCallback(() => {
    searchRequestRef.current++
    cancelSearchNavigation()
    setSearchOpen(false)
    setSearchQuery('')
    setSearchHits([])
    setSearchResultQuery('')
    setSearchIndex(-1)
    setHighlightMsgId(null)
  }, [cancelSearchNavigation])

  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      const isMac = window.api.platformInfo.os === 'mac'
      const modelShortcut =
        !e.repeat &&
        (e.key === 'm' || e.key === 'M') &&
        (isMac
          ? e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey
          : e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey)
      if (modelShortcut && modelChipRef.current) {
        e.preventDefault()
        modelChipRef.current.open()
        return
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        setSearchOpen(true)
      } else if (e.key === 'Escape' && searchOpen) {
        closeSearch()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, searchOpen, closeSearch])

  useEffect(
    () => () => {
      searchRequestRef.current++
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
      cancelSearchNavigation()
    },
    [cancelSearchNavigation]
  )

  const errorMsgFor = (error?: string) =>
    error === 'busy'
      ? t('view.errBusy')
      : error === 'no-model'
        ? t('view.errNoModel')
        : error === 'no-provider'
          ? t('view.errNoProvider')
          : error === 'account-pending-deletion'
            ? t('view.errAccountDeleting')
            : error === 'codex-accounts-exhausted'
              ? t('messages.accountsExhaustedError')
              : error === 'review-loop-active'
                ? t('view.errReviewLoopActive')
                : error === 'context-overflow'
                  ? t('view.errContextOverflow')
                  : error === 'context-compaction-failed'
                    ? t('view.errContextCompactionFailed')
                    : t('view.errSendFailed')

  const pushAssistantError = useCallback(
    (text: string) => {
      if (!visibleRef.current) return
      const errorId = crypto.randomUUID()
      setMessages((prev) =>
        normalizeHistoryWindow(
          prev,
          [...prev, { id: errorId, conversationId, role: 'assistant', parts: [], createdAt: Date.now(), error: text }],
          'replace',
          errorId
        )
      )
    },
    [conversationId, normalizeHistoryWindow]
  )

  const remoteCmdsRef = useRef<{ skills: ChatSkillCommand[] }>({ skills: [] })

  const slashSentRef = useRef(false)

  const agentMentionsSentRef = useRef(false)

  const imagesSentRef = useRef(false)

  useEffect(() => {
    slashSentRef.current = false
    agentMentionsSentRef.current = false
    imagesSentRef.current = false
  }, [conversationId])

  const doSend = useCallback(
    async (
      text: string,
      atts: UIAttachment[],
      agentMentions: StructuredAgentMentionDraft[] = [],
      updateVisual = visibleRef.current
    ) => {
      if (anchoredRef.current) {
        if (updateVisual) await reloadLatestPage()
        else {
          anchoredRef.current = false
        }
      }
      const parts: MessagePart[] = []

      const invocation = parseSlashInvocation(text)
      slashSentRef.current = invocation != null

      agentMentionsSentRef.current = agentMentions.length > 0

      imagesSentRef.current = atts.some((a) => a.kind === 'image')
      const invokedSkill = invocation
        ? remoteCmdsRef.current.skills.find((skill) => skill.name === invocation.name)
        : undefined
      if (invocation && invokedSkill) {
        parts.push({
          type: 'skill-invocation',
          id: crypto.randomUUID(),
          name: invokedSkill.name,
          ...(invocation.args ? { args: invocation.args } : {}),
          body: '',
        })
      } else if (text) parts.push({ type: 'text', id: crypto.randomUUID(), text })
      for (const a of atts)
        parts.push({
          type: 'file',
          id: a.id,
          name: a.name,
          mediaType: a.mediaType,
          kind: a.kind,
          ...(a.artifactId ? { artifactId: a.artifactId, byteSize: a.byteSize } : {}),
          ...(!a.artifactId && a.byteSize != null ? { byteSize: a.byteSize } : {}),
          ...(a.data ? { data: a.data } : {}),

          ...(a.previewUrl ? { previewUrl: a.previewUrl } : {}),
        })

      const mentionText = invocation && invokedSkill ? '' : text

      const catalogNames = (subagents ?? []).map((a) => a.name)
      for (const m of validateStructuredAgentMentions(agentMentions, mentionText, catalogNames)) {
        parts.push({ type: 'agent-mention', id: m.id, name: m.name, start: m.start, end: m.end })
      }
      if (updateVisual) {
        const optimisticId = crypto.randomUUID()
        setMessages((prev) =>
          normalizeHistoryWindow(
            prev,
            [...prev, { id: optimisticId, conversationId, role: 'user', parts, createdAt: Date.now() }],
            'replace',
            optimisticId
          )
        )
      }
      streamingRef.current = true
      if (updateVisual) setStreaming(true)
      const res = await window.api
        .chatSend(
          conversationId,
          text,
          atts.map((a) => ({
            name: a.name,
            mediaType: a.mediaType,
            kind: a.kind,
            data: a.data,
            bytes: a.bytes,
            artifactId: a.artifactId,
            byteSize: a.byteSize,
          })),
          agentMentions
        )

        .finally(() => {
          if (!updateVisual) revokeAttachmentPreviews(atts)
        })
      if (!res.ok) {
        slashSentRef.current = false
        agentMentionsSentRef.current = false
        imagesSentRef.current = false
        streamingRef.current = false
        if (visibleRef.current) setStreaming(false)
        if (res.error !== 'empty') pushAssistantError(errorMsgFor(res.error))
      }
    },
    [conversationId, pushAssistantError, reloadLatestPage, subagents]
  )

  const finishTurn = useCallback(
    (hidden = false) => {
      streamingRef.current = false
      if (!hidden) setStreaming(false)
      if (stoppedRef.current) {
        stoppedRef.current = false
        setStopPending(false)
        setQueueState([])
        return
      }
      const q = queueRef.current
      if (q.length > 0) {
        const [head, ...rest] = q
        setQueueState(rest)
        void doSend(head.text, head.attachments, head.agentMentions, !hidden)
      }
    },
    [doSend, setQueueState]
  )

  const pendingQuestionToolCallId = pendingQuestion?.toolCallId
  const needsLiveSubscription =
    visible ||
    queue.length > 0 ||
    pending.length > 0 ||
    stopPending ||
    maestroPostPending > 0 ||
    pendingQuestion !== null ||
    status === 'asking'
  useEffect(() => {
    if (!needsLiveSubscription) return

    const offStream = window.api.onChatStream(conversationId, (ev) => {
      const kind = (ev as { kind: string }).kind
      const hidden = !visibleRef.current
      const event = ev as ChatStreamEvent

      if (kind === 'done') {
        setActiveHarnessProfile(null)
        setMidTurnSteering(false)
        setLiveReasoningUpdate(false)
        runtimeQuestionRevisionRef.current += 1
        setRuntimeQuestionState([])
        finishTurn(hidden)
        if (hidden) return
        refreshStats()

        setModelRefresh((n) => n + 1)
        return
      }

      if (event.kind === 'runtime-capabilities') {
        setActiveHarnessProfile(event.activeHarnessProfile)
        setMidTurnSteering(event.midTurnSteering)
        setLiveReasoningUpdate(event.liveReasoningUpdate)
        return
      }
      if (event.kind === 'steering-accepted') {
        if (!hidden) {
          setMessages((prev) => normalizeHistoryWindow(prev, applyChatEvent(prev, event), 'replace', event.message.id))
        }
        return
      }

      if (kind !== 'finish' && kind !== 'aborted' && kind !== 'error') {
        streamingRef.current = true
        if (!hidden) setStreaming(true)
      }
      if (kind === 'user-saved') {
        const localSlash = slashSentRef.current
        const localAgentMentions = agentMentionsSentRef.current
        const localImages = imagesSentRef.current
        slashSentRef.current = false
        agentMentionsSentRef.current = false
        imagesSentRef.current = false
        const saved = ev as { compacted?: boolean; imagesDescribed?: number }
        if (
          shouldReloadOnUserSaved({
            streaming: streamingRef.current,
            compacted: saved.compacted,
            imagesDescribed: saved.imagesDescribed,
            localSlash,
            localAgentMentions,
            localImages,
          })
        )
          if (!hidden) void reloadLatestPage()
        return
      }
      if (event.kind === 'tool-state' && event.state.status !== 'pending' && event.state.status !== 'running') {
        runtimeQuestionRevisionRef.current += 1
        setRuntimeQuestionState((current) => current.filter((question) => question.toolCallId !== event.toolCallId))
      }

      if (hidden) {
        if (
          event.kind === 'tool-state' &&
          event.toolCallId === pendingQuestionToolCallId &&
          event.state.status !== 'pending' &&
          event.state.status !== 'running'
        ) {
          setMessages((prev) => normalizeHistoryWindow(prev, applyChatEvent(prev, event), 'replace', event.messageId))
        }
      }
      if (hidden) return

      setMessages((prev) => normalizeHistoryWindow(prev, applyChatEvent(prev, event), 'replace', event.messageId))

      if (kind === 'finish' || kind === 'aborted' || kind === 'error') setStreaming(false)
    })
    const offPerm = window.api.onChatPermission(conversationId, (ev) => {
      if (ev.kind === 'request') {
        if (visibleRef.current) setPending((prev) => [...prev.filter((r) => r.id !== ev.request.id), ev.request])
      } else if (ev.kind === 'resolved') {
        setPending((prev) => {
          const next = prev.filter((r) => r.id !== ev.requestId)
          return next.length === prev.length ? prev : next
        })
      }
    })
    return () => {
      offStream()
      offPerm()
    }
  }, [
    conversationId,
    finishTurn,
    needsLiveSubscription,
    normalizeHistoryWindow,
    pendingQuestionToolCallId,
    reloadLatestPage,
    refreshStats,
    setRuntimeQuestionState,
  ])

  useEffect(() => {
    if (!visible) return
    // Queue entries are renderer-local. A hidden stream advances queueRef without scheduling a React
    // render; reconcile that bounded state when the conversation becomes visible again.
    setQueueState((current) => (current === queueRef.current ? current : queueRef.current))

    void reloadLatestPage()
    let alive = true
    const questionRevision = runtimeQuestionRevisionRef.current
    const maestroRevision = maestroLiveRevisionRef.current
    void window.api.chatRuntime(conversationId).then((runtime) => {
      if (!alive || convIdRef.current !== conversationId) return
      streamingRef.current = runtime.streaming
      setStreaming(runtime.streaming)
      setPending(runtime.pendingPermissions)
      setActiveHarnessProfile(runtime.activeHarnessProfile)
      setMidTurnSteering(runtime.midTurnSteering)
      setLiveReasoningUpdate(runtime.liveReasoningUpdate)
      if (maestroRevision === maestroLiveRevisionRef.current) {
        const live = runtime.maestroLive ?? null
        maestroLiveRef.current = live
        setMaestroLive(live)
        if (live) {
          setQueueState((current) => {
            const preserved = current.filter((item) => item.maestroLive?.runId !== live.run.id)
            const pendingLive: QueuedMsg[] = live.messages
              .filter((message) => message.status === 'pending')
              .map((message) => ({
                id: message.id,
                text: message.text,
                attachments: [],
                agentMentions: message.agentMentions,
                maestroLive: { runId: live.run.id, messageId: message.id },
              }))
            return [...preserved, ...pendingLive]
          })
        }
      }
      if (questionRevision === runtimeQuestionRevisionRef.current) {
        setRuntimeQuestionState(runtime.pendingQuestions)
        setMessages((prev) => {
          const hydrated = mergePendingChatQuestions(prev, conversationId, runtime.pendingQuestions)
          return normalizeHistoryWindow(prev, hydrated, 'replace', runtime.pendingQuestions.at(-1)?.messageId)
        })
      }
    })
    return () => {
      alive = false
    }
  }, [conversationId, normalizeHistoryWindow, reloadLatestPage, setQueueState, setRuntimeQuestionState, visible])

  useEffect(() => {
    Promise.all([window.api.chatGetSelection(conversationId), window.api.chatConfig()]).then(([sel, cfg]) => {
      const p = sel ? cfg.providers.find((pp) => pp.id === sel.providerId) : undefined
      setKeyMissing(!p || !isChatProviderConnected(p))
      setSelModelId(sel?.modelId ?? null)
      setSelProviderId(sel?.providerId ?? null)
      setChatProviders(cfg.providers)
    })
  }, [conversationId, messages.length, modelRefresh])

  useEffect(() => {
    setFailoverNotice(null)
    const defaultLabel = t('settings.codexSubscriptionHeading')
    const labelFor = (providerId: string): string => {
      const provider = chatProviders.find((entry) => entry.id === providerId)
      if (!provider) return providerId
      if (provider.accountId) return provider.accountLabel?.trim() || provider.accountId
      return defaultLabel
    }
    return window.api.onChatSubscriptionFailover(conversationId, (ev: ChatSubscriptionFailoverEvent) => {
      setFailoverNotice(
        t('settings.failoverSwitchStatus', {
          from: labelFor(ev.fromProviderId),
          to: labelFor(ev.toProviderId),
        })
      )
    })
  }, [conversationId, chatProviders, t])

  useEffect(() => {
    if (!failoverNotice) return
    const timer = window.setTimeout(() => setFailoverNotice(null), 6_000)
    return () => window.clearTimeout(timer)
  }, [failoverNotice])

  useEffect(() => {
    const unsubscribes = CHAT_SUBSCRIPTION_PROVIDER_KINDS.map((provider) =>
      window.api.onChatSubscriptionStatus(provider, () => setModelRefresh((n) => n + 1))
    )
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe())
  }, [])

  useEffect(() => {
    const ownsConversation = (loop: ReviewLoopInfo) =>
      loop.participants.executor.conversationId === conversationId ||
      loop.participants.reviewer?.conversationId === conversationId
    const refresh = () => void window.api.chatReviewLoopStatus(conversationId).then(setReviewLoop)
    void refresh()
    return window.api.onChatReviewLoopChanged((loops) => setReviewLoop(loops.find(ownsConversation) ?? null))
  }, [conversationId])

  useEffect(() => {
    if (!selModelId) {
      setModelMeta(null)
      return
    }
    let alive = true

    window.api.chatModelMeta(selModelId, selProviderId ?? undefined).then((m) => {
      if (alive) setModelMeta(m)
    })
    return () => {
      alive = false
    }
  }, [selModelId, selProviderId, modelRefresh])

  const [metaByModel, setMetaByModel] = useState<Record<string, ChatModelMeta | null>>({})
  const metaByModelRef = useRef(metaByModel)
  metaByModelRef.current = metaByModel

  const modelPairsKey = useMemo(() => {
    const pairs = new Map<string, [string, string]>()
    for (const pm of historyStats?.perModel ?? []) {
      if (!pm.modelId) continue
      const providerId = pm.providerId ?? ''
      pairs.set(`${providerId}\0${pm.modelId}`, [providerId, pm.modelId])
    }
    if (selModelId) pairs.set(`${selProviderId ?? ''}\0${selModelId}`, [selProviderId ?? '', selModelId])
    return JSON.stringify(
      [...pairs.values()].sort(([pa, ma], [pb, mb]) => pa.localeCompare(pb) || ma.localeCompare(mb))
    )
  }, [historyStats, selModelId, selProviderId])
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

  useEffect(() => {
    if (isMaestro) {
      setMode('agent')
      return
    }
    window.api.chatGetMode(conversationId).then(setMode)
    return window.api.onChatModeChanged(conversationId, setMode)
  }, [conversationId, isMaestro])

  useEffect(() => {
    window.api.chatGetReasoning(conversationId).then(setReasoning)
  }, [conversationId])
  const applyReasoning = useCallback(
    (r: ChatReasoningEffort) => {
      setReasoning(r)
      void window.api.chatSetReasoning(conversationId, r)
      const supportedEfforts = modelMeta?.reasoning
        ? modelMeta.reasoningEfforts?.length
          ? modelMeta.reasoningEfforts
          : [...DEFAULT_REASONING_EFFORTS]
        : []
      if (
        routeAstraReasoningChange({
          streaming: streamingRef.current,
          activeHarnessProfile,
          liveReasoningUpdate,
          effort: r,
          supportedEfforts,
        }) === 'live-and-next-turn'
      ) {
        void window.api.chatUpdateLiveReasoning(conversationId, r)
      }
    },
    [activeHarnessProfile, conversationId, liveReasoningUpdate, modelMeta]
  )

  const applyMode = useCallback(
    (m: ChatMode) => {
      if (isMaestro) return
      setMode(m)
      void window.api.chatSetMode(conversationId, m)
    },
    [conversationId, isMaestro]
  )

  const cycleMode = useCallback(() => {
    if (isMaestro) return
    const order: ChatMode[] = ['agent', 'plan', 'ask']
    setMode((cur) => {
      const next = order[(order.indexOf(cur) + 1) % order.length]
      void window.api.chatSetMode(conversationId, next)
      return next
    })
  }, [conversationId, isMaestro])

  const convertMaestroToStandard = useCallback(async () => {
    const result = await window.api.chatMaestroConvertToStandard(conversationId)
    if (result.ok) {
      const restoredMode = await window.api.chatGetMode(conversationId)
      setCurrentExperience('standard')
      setMode(restoredMode)
      onExperienceChange?.(conversationId, 'standard')
    }
    return result
  }, [conversationId, onExperienceChange])

  const convertStandardToMaestro = useCallback(async () => {
    const result = await window.api.chatStandardConvertToMaestro(conversationId)
    if (result.ok) {
      setCurrentExperience('maestro')
      setMode('agent')
      onExperienceChange?.(conversationId, 'maestro')
    }
    return result
  }, [conversationId, onExperienceChange])

  const submitDraft = useCallback(
    ({ text: rawText, agentMentions }: { text: string; agentMentions: StructuredAgentMentionDraft[] }) => {
      const text = rawText
      if (!text.trim() && attachments.length === 0) return
      const atts = attachments
      setDraft('')
      setDraftMentions([])
      setAttachments([])
      if (streamingRef.current) {
        const live = maestroLiveRef.current
        if (isMaestro && maestroSendTarget === 'current' && atts.length === 0 && live?.run.status === 'active') {
          setMaestroPostPending((count) => count + 1)
          void window.api
            .chatMaestroLivePost(conversationId, live.run.id, text, agentMentions)
            .then((result) => {
              if (result.ok) {
                applyMaestroLiveEvent({ kind: 'message-posted', run: result.run, message: result.message })
                setQueueState((current) => [
                  ...current,
                  {
                    id: result.message.id,
                    text,
                    attachments: [],
                    agentMentions,
                    maestroLive: { runId: result.run.id, messageId: result.message.id },
                  },
                ])

                void window.api.chatMaestroLiveSnapshot(conversationId).then((snapshot) => {
                  if (!snapshot || convIdRef.current !== conversationId) return
                  applyMaestroLiveEvent({
                    kind: 'messages-updated',
                    run: snapshot.run,
                    messages: snapshot.messages,
                  })
                })
                return
              }

              setQueueState((current) => [
                ...current,
                { id: crypto.randomUUID(), text, attachments: [], agentMentions },
              ])
            })
            .catch(() =>
              setQueueState((current) => [
                ...current,
                { id: crypto.randomUUID(), text, attachments: [], agentMentions },
              ])
            )
            .finally(() => setMaestroPostPending((count) => Math.max(0, count - 1)))
          return
        }
        const invocation = parseSlashInvocation(text)
        const invokesSkill = Boolean(
          invocation && remoteCmdsRef.current.skills.some((skill) => skill.name === invocation.name)
        )
        if (
          routeAstraComposerSubmit({
            streaming: true,
            activeHarnessProfile,
            midTurnSteering,
            text,
            attachmentCount: atts.length,
            agentMentionCount: agentMentions.length,
            invokesSkill,
            maestro: isMaestro,
          }) === 'steer'
        ) {
          const clientUserMessageId = crypto.randomUUID()
          const enqueueFallback = () =>
            setQueueState((current) =>
              current.some((item) => item.id === clientUserMessageId)
                ? current
                : [...current, { id: clientUserMessageId, text, attachments: [], agentMentions: [] }]
            )
          void window.api
            .chatSteer(conversationId, text, clientUserMessageId)
            .then((result) => {
              if (!result.ok || !result.accepted) enqueueFallback()
            })
            .catch(enqueueFallback)
          return
        }
        setQueueState((q) => [...q, { id: crypto.randomUUID(), text, attachments: atts, agentMentions }])
        if (isMaestro) setMaestroSendTarget('current')
        return
      }
      void doSend(text, atts, agentMentions)
    },
    [
      activeHarnessProfile,
      applyMaestroLiveEvent,
      attachments,
      conversationId,
      doSend,
      isMaestro,
      maestroSendTarget,
      midTurnSteering,
      setQueueState,
    ]
  )

  const searchFiles = useCallback((q: string) => window.api.chatSearchFiles(conversationId, q), [conversationId])

  // ChatPlusMenu → ConversationSubagentProfiles).

  const reloadSubagents = useCallback(() => {
    setSubagents(null)
    const request = isMaestro
      ? window.api.chatMaestroGetConversation(conversationId).then((payload) => ({
          agents: payload.config.pool
            .filter((resource) => resource.enabled)
            .map((resource) => ({
              name: resource.id,
              description: resource.description,
              category: resource.specialties[0],
              source: resource.agentName ? `maestro-import:${resource.agentName}` : 'maestro-pool',
              virtual: true,
              baseAgentName: resource.agentName,
            })),
        }))
      : window.api.chatSubagentProfilesCatalog(conversationId)
    request.then((catalog) => {
      if (convIdRef.current === conversationId) setSubagents(catalog.agents)
    })
  }, [conversationId, isMaestro])
  useEffect(() => {
    reloadSubagents()
  }, [reloadSubagents, visible])
  useEffect(() => {
    if (!visible) return

    return subscribeSubagentProfilesChanged(reloadSubagents)
  }, [reloadSubagents, visible])

  const openMention = useCallback(
    (relPath: string, startLine?: number, endLine?: number) =>
      void window.api.openPlanFile(conversationId, relPath, startLine, endLine),
    [conversationId]
  )

  const [remoteCmds, setRemoteCmds] = useState<{
    prompts: ChatUserPrompt[]
    project: ChatProjectCommand[]
    skills: ChatSkillCommand[]
  }>({ prompts: [], project: [], skills: [] })
  remoteCmdsRef.current = remoteCmds

  const reloadCommands = useCallback(() => {
    void window.api.chatCommands(conversationId).then(setRemoteCmds)
  }, [conversationId])
  useEffect(() => {
    if (!visible) return
    window.addEventListener('maestrly:skills-changed', reloadCommands)
    return () => window.removeEventListener('maestrly:skills-changed', reloadCommands)
  }, [reloadCommands, visible])
  useEffect(() => {
    if (!visible) return
    let alive = true
    window.api.chatCommands(conversationId).then((c) => {
      if (alive) setRemoteCmds(c)
    })
    return () => {
      alive = false
    }
  }, [conversationId, visible])

  const commands = useMemo<ChatSlashCommand[]>(
    () => [
      { name: 'clear', description: t('view.cmdClear'), kind: 'action', action: 'clear' },
      { name: 'compact', description: t('view.cmdCompact'), kind: 'action', action: 'compact' },
      ...remoteCmds.skills.map((s) => ({
        name: s.name,
        description: s.description,
        kind: 'skill' as const,
        argumentHint: s.argumentHint,
      })),
      ...remoteCmds.prompts.map((p) => ({
        name: p.name,
        description: p.description,
        kind: 'prompt' as const,
        content: p.content,
      })),
      ...remoteCmds.project.map((p) => ({
        name: p.name,
        description: p.description,
        kind: 'project' as const,
        content: p.content,
      })),
    ],
    [remoteCmds, t]
  )

  const runCompactAsync = useCallback(async (): Promise<boolean> => {
    if (streamingRef.current || compactingRef.current) return false
    setCompacting(true)
    try {
      const res = await window.api.chatCompact(conversationId)
      if (res.ok) {
        await reloadLatestPage()
        setCompactDismissed(false)
        return true
      }
      if (res.error !== 'too-short') {
        pushAssistantError(res.error === 'no-model' ? t('view.errNoModel') : t('view.errCompactFailed'))
        return false
      }
      return true // No compaction is needed; continue.
    } finally {
      setCompacting(false)
    }
  }, [conversationId, pushAssistantError, reloadLatestPage, t])
  const runCompact = useCallback(() => void runCompactAsync(), [runCompactAsync])

  const pickCommand = useCallback(
    (cmd: ChatSlashCommand) => {
      if (cmd.kind === 'action') {
        if (cmd.action === 'clear') {
          void window.api.chatClear(conversationId).then((result) => {
            if (!result.ok) return
            setMessages([])
            for (const item of queueRef.current) revokeAttachmentPreviews(item.attachments)
            setQueueState([])
            setDraft('')
            setDraftMentions([])
            setHasMore(false)
            earliestSeqRef.current = null
            setHistoryStats(null)
          })
        } else if (cmd.action === 'compact') {
          setDraft('')
          setDraftMentions([])
          runCompact()
        }
        return
      }

      if (cmd.kind === 'skill') {
        setDraft(`/${cmd.name} `)
        setDraftMentions([])
        return
      }
      setDraft((cmd.content ?? '').replace(/\$ARGUMENTS/g, '').trim())
      setDraftMentions([])
    },
    [conversationId, runCompact, setQueueState]
  )

  useEffect(
    () =>
      window.api.onChatReference(conversationId, (r) => {
        const range = r.startLine
          ? `:L${r.startLine}${r.endLine && r.endLine !== r.startLine ? '-' + r.endLine : ''}`
          : ''

        const p = r.path.includes('/') || r.path.includes('.') ? r.path : './' + r.path
        const mention = `@${p}${range}`
        setDraft((d) => (d && !d.endsWith(' ') ? `${d} ${mention} ` : `${d}${mention} `))
      }),
    [conversationId]
  )

  // Apply both per-file limits and aggregate image budgets to the existing draft plus the new batch.

  const addFiles = useCallback((files: File[]) => {
    void (async () => {
      const existing = attachmentsRef.current
      const candidates: UIAttachment[] = []

      let imageBytes = existing.reduce(
        (sum, a) => sum + (a.kind === 'image' ? (a.byteSize ?? a.bytes?.byteLength ?? 0) : 0),
        0
      )
      let imageCount = existing.filter((a) => a.kind === 'image').length
      for (const file of files) {
        const isImage = file.type.startsWith('image/')
        if (isImage) {
          if (file.size > MAX_ATTACHMENT_IMAGE_BYTES) continue
          if (imageCount >= MAX_ATTACHMENT_IMAGES_PER_MESSAGE) continue
          if (imageBytes + file.size > MAX_ATTACHMENT_IMAGE_BYTES_PER_MESSAGE) continue
          const bytes = new Uint8Array(await file.arrayBuffer())
          imageBytes += bytes.byteLength
          imageCount += 1
          candidates.push({
            id: crypto.randomUUID(),
            name: file.name,
            mediaType: file.type || 'image/png',
            kind: 'image',
            bytes,
            byteSize: bytes.byteLength,
            previewUrl: URL.createObjectURL(file),
          })
        } else {
          if (file.size > MAX_ATTACHMENT_TEXT_BYTES) continue
          const data = await file.text()
          candidates.push({
            id: crypto.randomUUID(),
            name: file.name,
            mediaType: file.type || 'text/plain',
            kind: 'text',
            data,
            byteSize: new TextEncoder().encode(data).length,
          })
        }
      }
      if (candidates.length === 0) return

      // Functional updaters reconcile concurrent additions; revoke previews for rejected attachments.
      setAttachments((prev) => {
        const { kept, rejected } = boundDraftAttachments(prev, candidates)
        for (const item of rejected) revokeAttachmentPreview(item)
        return kept
      })
    })()
  }, [])
  const removeAttachment = useCallback(
    (id: string) =>
      setAttachments((prev) => {
        const removed = prev.find((attachment) => attachment.id === id)
        if (removed) revokeAttachmentPreview(removed)
        return prev.filter((attachment) => attachment.id !== id)
      }),
    []
  )

  const stop = useCallback(() => {
    stoppedRef.current = true
    setStopPending(true)
    window.api.chatStop(conversationId)
    setStreaming(false)
    for (const item of queueRef.current) revokeAttachmentPreviews(item.attachments)
    setQueueState([]) // Stop cancels the active turn and the pending queue.
  }, [conversationId, setQueueState])

  const decide = useCallback((requestId: string, reply: 'once' | 'always' | 'reject') => {
    setPending((prev) => prev.filter((r) => r.id !== requestId))
    window.api.chatPermissionRespond(requestId, reply)
  }, [])

  const startEdit = useCallback((id: string) => setEditingId(id), [])
  const cancelEdit = useCallback(() => setEditingId(null), [])

  const submitEdit = useCallback(
    async (id: string, payload: { text: string; agentMentions: StructuredAgentMentionDraft[] }) => {
      const { text, agentMentions } = payload
      setEditingId(null)
      let resendHasImage = false
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === id)
        const kept = idx >= 0 ? prev.slice(0, idx) : prev

        const files = (idx >= 0 ? prev[idx].parts : []).filter(
          (p): p is Extract<MessagePart, { type: 'file' }> => p.type === 'file' && !p.hidden
        )
        resendHasImage = files.some((p) => p.kind === 'image')
        const parts: MessagePart[] = []

        if (text.trim()) parts.push({ type: 'text', id: crypto.randomUUID(), text })
        parts.push(...files)

        const catalogNames = (subagents ?? []).map((a) => a.name)
        for (const m of validateStructuredAgentMentions(agentMentions, text, catalogNames)) {
          parts.push({ type: 'agent-mention', id: m.id, name: m.name, start: m.start, end: m.end })
        }
        const optimisticId = crypto.randomUUID()
        return normalizeHistoryWindow(
          prev,
          [...kept, { id: optimisticId, conversationId, role: 'user', parts, createdAt: Date.now() }],
          'replace',
          optimisticId
        )
      })

      const invocation = parseSlashInvocation(text)
      slashSentRef.current = invocation != null
      agentMentionsSentRef.current = agentMentions.length > 0

      imagesSentRef.current = resendHasImage
      setStreaming(true)
      const res = await window.api.chatResend(conversationId, id, text, agentMentions)
      if (!res.ok) {
        slashSentRef.current = false
        agentMentionsSentRef.current = false
        imagesSentRef.current = false
        setStreaming(false)
        if (res.error !== 'empty') pushAssistantError(errorMsgFor(res.error))
      }
    },
    [conversationId, pushAssistantError, subagents]
  )

  const contextRatio = useMemo(() => {
    const runtimeWindow = historyStats?.contextProjection?.modelContextWindow
    const win = runtimeWindow ?? modelMeta?.contextWindow

    const used =
      historyStats?.contextProjection?.usedTokens ??
      (historyStats?.lastUsage ? contextOccupancy(historyStats.lastUsage) : 0)
    if (!win || !used) return null
    return used / win
  }, [historyStats, modelMeta, selModelId, selProviderId])
  const showCompactBanner =
    contextRatio != null &&
    contextRatio >= 0.8 &&
    !compactDismissed &&
    !compacting &&
    !streaming &&
    messages.length >= 2

  const maestroRuns = useMemo<MaestroRun[]>(() => {
    const runs: MaestroRun[] = []
    for (const message of messages) {
      const parts = message.parts.filter(
        (part): part is DelegatePart => part.type === 'tool' && part.toolName === 'delegate'
      )
      if (parts.length > 0) runs.push({ messageId: message.id, parts })
    }
    return runs
  }, [messages])

  const reloadSubagentSessions = useCallback(async () => {
    const sessions = await window.api.chatSubagentSessions(conversationId, { limit: 200 })
    setSubagentSessions(sessions)
    return sessions
  }, [conversationId])

  useEffect(() => {
    if (!visible) return
    void reloadSubagentSessions()
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = window.api.onChatSubagentSession(conversationId, () => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        void reloadSubagentSessions()
      }, 120)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [conversationId, reloadSubagentSessions, visible])

  const openSubagentSession = useCallback<OpenSubagentSession>(
    async ({ conversationId: ownerConversationId, parentMessageId, toolCallId }) => {
      if (ownerConversationId !== conversationId) return false
      const session = await window.api.chatSubagentResolve(conversationId, parentMessageId, toolCallId)
      if (!session) return false
      setSubagentSessions((current) => [session, ...current.filter((item) => item.id !== session.id)])
      setSelectedSubagentSessionId(session.id)
      return true
    },
    [conversationId]
  )

  const beginSubagentPaneResize = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    const root = rootRef.current
    if (!root) return
    const onMove = (move: MouseEvent) => {
      const rect = root.getBoundingClientRect()
      const percent = ((rect.right - move.clientX) / Math.max(1, rect.width)) * 100
      setSubagentPaneWidth(Math.max(28, Math.min(65, percent)))
    }
    const onUp = () => {
      document.body.style.cursor = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp, { once: true })
  }, [])

  useEffect(() => {
    if (!selectedSubagentSessionId) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedSubagentSessionId(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedSubagentSessionId])

  const reasoningEfforts = modelMeta?.reasoning
    ? modelMeta.reasoningEfforts?.length
      ? modelMeta.reasoningEfforts
      : [...DEFAULT_REASONING_EFFORTS]
    : []

  const maestrlyUltraActive =
    reasoning === MAESTRLY_ULTRA_EFFORT || (modelMeta !== null && isMaestrlyUltraEffort(reasoning, reasoningEfforts))

  const ultraVisualActive = maestrlyUltraActive || (modelMeta?.nativeUltraMode === true && reasoning === 'ultra')
  const cycleReasoning = useCallback(() => {
    const next = nextQuickReasoningEffort(reasoning, reasoningEfforts, modelMeta?.nativeUltraMode === true)
    applyReasoning(next)
  }, [applyReasoning, modelMeta?.nativeUltraMode, reasoning, reasoningEfforts])
  const canCycleReasoning = modelMeta?.reasoning === true || maestrlyUltraActive
  const maestroLiveActive = isMaestro && streaming && maestroLive?.run.status === 'active'
  const effectiveMaestroTarget = attachments.length > 0 ? 'next' : maestroSendTarget
  const experienceTransitionDisabled =
    streaming ||
    compacting ||
    reviewLoopActive ||
    queue.length > 0 ||
    maestroPostPending > 0 ||
    pending.length > 0 ||
    pendingQuestion !== null

  return (
    <SubagentSessionContext.Provider value={openSubagentSession}>
      <SubagentSessionsContext.Provider value={subagentSessions}>
        <div
          ref={rootRef}
          id={maestroPanelHostId}
          className={cn(
            'relative flex h-full w-full flex-row bg-[#0d0d10]',
            ultraVisualActive && 'ring-1 ring-inset ring-fuchsia-500/30 shadow-[inset_0_0_32px_rgba(217,70,239,0.05)]'
          )}
          style={
            {
              '--chat-font': `${(14.5 * fontScale).toFixed(2)}px`,
              '--subagent-pane-width': `${subagentPaneWidth}%`,
            } as CSSProperties
          }
        >
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="relative flex min-h-0 flex-1 flex-col">
              {searchOpen && (
                <ChatSearchBar
                  query={searchQuery}
                  onQueryChange={changeSearchQuery}
                  total={searchHits.length}
                  index={searchIndex}
                  loading={searchLoading}
                  onPrev={() => stepSearch(-1)}
                  onNext={() => stepSearch(1)}
                  onClose={closeSearch}
                />
              )}
              <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
                <ChatMessageList
                  messages={messages}
                  experience={currentExperience}
                  streaming={streaming}
                  visible={visible}
                  agents={subagents}
                  editingId={editingId}
                  onStartEdit={startEdit}
                  onCancelEdit={cancelEdit}
                  onSubmitEdit={submitEdit}
                  onRetrySteering={(text) =>
                    setQueueState((current) => [
                      ...current,
                      { id: crypto.randomUUID(), text, attachments: [], agentMentions: [] },
                    ])
                  }
                  onOpenMention={openMention}
                  scrollContainerRef={scrollRef}
                  onLoadOlder={loadOlder}
                  hasMore={hasMore}
                  highlightMsgId={highlightMsgId}
                  searchQuery={searchOpen && searchResultQuery === searchQuery.trim() ? searchResultQuery : undefined}
                  searchHitIds={searchHitIds}
                  currentSearchHitId={currentSearchHitId}
                />
              </div>

              {!atBottom && messages.length > 0 && (
                <button
                  type="button"
                  onClick={scrollToBottom}
                  title={t('messages.goToBottom')}
                  className="absolute bottom-3 left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-white/[0.1] bg-[#1a1a1f]/95 text-foreground shadow-lg backdrop-blur transition hover:bg-[#26262d]"
                >
                  <ArrowDown className="h-4 w-4" />
                </button>
              )}

              {isMaestro ? (
                <MaestroActivityPill
                  runs={maestroRuns}
                  conversationId={conversationId}
                  liveState={maestroLive}
                  onOpenMention={openMention}
                  onJumpToMessage={jumpToMessage}
                />
              ) : (
                <SubagentActivityPill sessions={subagentSessions} />
              )}
            </div>

            {pending.map((req) => (
              <PermissionPrompt key={req.id} request={req} onDecide={(reply) => decide(req.id, reply)} />
            ))}

            {compacting && (
              <div className="mx-auto flex w-full max-w-3xl items-center gap-1.5 px-4 pb-1 text-[12px] text-muted-foreground">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground" />
                {t('view.compacting')}
              </div>
            )}

            {showCompactBanner && (
              <div className="mx-auto mb-1 flex w-full max-w-3xl items-center gap-2 px-4">
                <div className="flex flex-1 items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.08] px-3 py-1.5 text-[12px] text-amber-200">
                  <span className="min-w-0 flex-1">
                    {t('view.autoCompactBanner', { pct: Math.round((contextRatio ?? 0) * 100) })}
                  </span>
                  <button
                    type="button"
                    onClick={runCompact}
                    className="shrink-0 rounded-md bg-amber-500/20 px-2 py-0.5 font-medium text-amber-100 hover:bg-amber-500/30"
                  >
                    {t('view.compactButton')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setCompactDismissed(true)}
                    className="shrink-0 text-amber-300/70 hover:text-amber-100"
                    title={t('view.dismiss')}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}

            {queue.length > 0 && (
              <div className="mx-auto w-full max-w-3xl px-4 pb-1">
                <div className="mb-1 text-[11px] text-muted-foreground">
                  {t('view.queueCount', { count: queue.length })}
                </div>
                <div className="flex flex-col gap-1">
                  {queue.map((q) => (
                    <div
                      key={q.id}
                      className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-1.5 text-[13px]"
                    >
                      <span className="min-w-0 flex-1 truncate text-foreground">{q.text}</span>
                      {q.maestroLive && (
                        <span className="shrink-0 rounded bg-amber-400/10 px-1.5 py-0.5 text-[10px] text-amber-200">
                          {t('view.maestroLiveWaiting')}
                        </span>
                      )}
                      <button
                        type="button"
                        title={t('view.queueEdit')}
                        onClick={() => {
                          if (q.maestroLive) {
                            void window.api.chatMaestroLiveCancel(
                              conversationId,
                              q.maestroLive.runId,
                              q.maestroLive.messageId
                            )
                          }
                          setDraft(q.text)
                          setDraftMentions(q.agentMentions)
                          setAttachments(q.attachments)
                          setQueueState((cur) => cur.filter((x) => x.id !== q.id))
                        }}
                        className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        title={t('view.queueRemove')}
                        onClick={() => {
                          if (q.maestroLive) {
                            void window.api.chatMaestroLiveCancel(
                              conversationId,
                              q.maestroLive.runId,
                              q.maestroLive.messageId
                            )
                          }
                          revokeAttachmentPreviews(q.attachments)
                          setQueueState((cur) => cur.filter((x) => x.id !== q.id))
                        }}
                        className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <ChatGptWebSessionBanner conversationId={conversationId} starting={companionStarting} />
            {reviewLoop?.driver === 'maestrly-pair' && (
              <ReviewLoopBanner conversationId={conversationId} loop={reviewLoop} />
            )}

            {failoverNotice && (
              <div className="mx-auto mb-1.5 w-full max-w-3xl px-1">
                <div
                  role="status"
                  className="flex items-center gap-2 rounded-lg border border-sky-500/25 bg-sky-500/[0.08] px-3 py-1.5 text-[12px] text-sky-100"
                >
                  <span className="min-w-0 flex-1">{failoverNotice}</span>
                  <button
                    type="button"
                    onClick={() => setFailoverNotice(null)}
                    className="rounded p-0.5 text-sky-200/80 hover:text-sky-50"
                    aria-label={t('messages.cancel')}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}

            {pendingQuestion ? (
              <QuestionComposer
                key={pendingQuestion.toolCallId}
                questions={pendingQuestion.questions}
                onSubmit={(answers) => window.api.chatQuestionRespond(pendingQuestion.toolCallId, answers)}
                onDismiss={() => window.api.chatQuestionRespond(pendingQuestion.toolCallId, [])}
              />
            ) : (
              <ChatComposer
                ref={composerRef}
                value={draft}
                onChange={setDraft}
                onMentionsChange={setDraftMentions}
                structuredAgentMentions={draftMentions}
                streaming={streaming}
                sendWhileStreaming={maestroLiveActive || (midTurnSteering && activeHarnessProfile === 'openai-gpt-6-astra-v1')}
                streamingPlaceholder={maestroLiveActive ? t('composer.placeholderMaestroLive') : undefined}
                disabled={keyMissing || reviewLoopActive}
                onSend={submitDraft}
                onStop={stop}
                attachments={attachments}
                onAddFiles={addFiles}
                onRemoveAttachment={removeAttachment}
                onSearchFiles={searchFiles}
                onOpenMention={openMention}
                agents={subagents}
                commands={commands}
                onPickCommand={pickCommand}
                onCycleMode={isMaestro ? undefined : cycleMode}
                onCycleReasoning={canCycleReasoning ? cycleReasoning : undefined}
                micSlot={
                  <ChatMicButton
                    onTranscribed={(t) => setDraft((d) => (d.trim() ? d.replace(/\s*$/, ' ') + t : t))}
                    disabled={keyMissing}
                  />
                }
                leftSlot={
                  <>
                    {maestroLiveActive && (
                      <button
                        type="button"
                        onClick={() => setMaestroSendTarget((current) => (current === 'current' ? 'next' : 'current'))}
                        disabled={attachments.length > 0}
                        className={cn(
                          'mr-1 rounded-full border px-2 py-0.5 text-[11px] transition',
                          effectiveMaestroTarget === 'current'
                            ? 'border-amber-400/30 bg-amber-400/10 text-amber-100'
                            : 'border-white/10 bg-white/[0.03] text-muted-foreground',
                          attachments.length > 0 && 'cursor-not-allowed opacity-60'
                        )}
                        title={
                          attachments.length > 0
                            ? t('composer.maestroAttachmentsNext')
                            : t('composer.maestroTargetToggle')
                        }
                      >
                        {effectiveMaestroTarget === 'current'
                          ? t('composer.maestroTargetCurrent')
                          : t('composer.maestroTargetNext')}
                      </button>
                    )}
                    <ChatPlusMenu
                      conversationId={conversationId}
                      mode={mode}
                      onAddFiles={addFiles}
                      fontScale={fontScale}
                      onFontScale={setFontScale}
                      onCompanionStarting={setCompanionStarting}
                    />
                    <ChatSkillsMenu conversationId={conversationId} onChanged={reloadCommands} />
                    {isMaestro ? (
                      <MaestroControl
                        conversationId={conversationId}
                        panelHostId={maestroPanelHostId}
                        onChanged={reloadSubagents}
                        onConvertToStandard={convertMaestroToStandard}
                        convertToStandardDisabled={experienceTransitionDisabled}
                        directModelId={selModelId}
                        orchestratorSlot={
                          <>
                            {(modelMeta?.reasoning || maestrlyUltraActive) && (
                              <ChatReasoningPicker
                                value={reasoning}
                                onChange={applyReasoning}
                                efforts={reasoningEfforts}
                                nativeUltraMode={modelMeta?.nativeUltraMode === true}
                              />
                            )}
                            {modelMeta?.fastModeCapability === true && (
                              <ChatFastModeToggle conversationId={conversationId} />
                            )}
                            <ChatModelChip
                              ref={modelChipRef}
                              conversationId={conversationId}
                              refreshToken={modelRefresh}
                              onChange={(selection) => {
                                setSelProviderId(selection.providerId)
                                setSelModelId(selection.modelId)
                                setModelMeta(null)
                                setModelRefresh((n) => n + 1)
                                refreshStats()
                              }}
                            />
                          </>
                        }
                      />
                    ) : (
                      <>
                        <ChatModePicker
                          conversationId={conversationId}
                          mode={mode}
                          onChange={applyMode}
                          onUseMaestro={convertStandardToMaestro}
                          maestroDisabled={experienceTransitionDisabled || !selModelId}
                          modelId={selModelId}
                        />
                        {(modelMeta?.reasoning || maestrlyUltraActive) && (
                          <ChatReasoningPicker
                            value={reasoning}
                            onChange={applyReasoning}
                            efforts={reasoningEfforts}
                            nativeUltraMode={modelMeta?.nativeUltraMode === true}
                          />
                        )}
                        {modelMeta?.fastModeCapability === true && (
                          <ChatFastModeToggle conversationId={conversationId} />
                        )}
                        <ChatModelChip
                          ref={modelChipRef}
                          conversationId={conversationId}
                          refreshToken={modelRefresh}
                          onChange={(selection) => {
                            setSelProviderId(selection.providerId)
                            setSelModelId(selection.modelId)
                            setModelMeta(null)
                            setModelRefresh((n) => n + 1)
                            refreshStats()
                            requestAnimationFrame(() => composerRef.current?.focus())
                          }}
                        />
                      </>
                    )}
                  </>
                }
                metaSlot={
                  <>
                    {!isMaestro && <ChatPermModePicker conversationId={conversationId} />}
                    <ChatContextMeter
                      stats={historyStats}
                      meta={modelMeta}
                      metaByModel={metaByModel}
                      providerId={selProviderId}
                      modelId={selModelId}
                      onLimitChange={() => {
                        setModelRefresh((n) => n + 1)
                        refreshStats()
                      }}
                    />
                  </>
                }
              />
            )}
          </div>

          {selectedSubagentSessionId && (
            <>
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={t('subagentSession.resize')}
                tabIndex={0}
                onMouseDown={beginSubagentPaneResize}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft') setSubagentPaneWidth((value) => Math.min(65, value + 2))
                  if (event.key === 'ArrowRight') setSubagentPaneWidth((value) => Math.max(28, value - 2))
                }}
                className="hidden w-1 shrink-0 cursor-col-resize bg-violet-400/10 transition-colors hover:bg-violet-400/35 lg:block"
              />
              <div className="absolute inset-0 z-30 min-h-0 min-w-0 bg-[#111018] lg:relative lg:inset-auto lg:z-auto lg:h-full lg:w-[var(--subagent-pane-width)] lg:shrink-0">
                <SubagentSessionPanel
                  conversationId={conversationId}
                  sessionId={selectedSubagentSessionId}
                  sessions={subagentSessions}
                  onSelect={setSelectedSubagentSessionId}
                  onClose={() => setSelectedSubagentSessionId(null)}
                  onOpenMention={openMention}
                />
              </div>
            </>
          )}
        </div>
      </SubagentSessionsContext.Provider>
    </SubagentSessionContext.Provider>
  )
}
