import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  CircleCheck,
  Clock,
  Loader2,
  Pencil,
  Trash2,
  X,
} from 'lucide-react'
import type { ChatConfig, ChatMessage, MessagePart, ToolOutput } from '../../../shared/chat'
import { toolOutputText } from '../../../shared/chat'
import { LOCAL_HOST_ID } from '../../../shared/host-key'
import {
  isRoutineRunSkipped,
  type LocalRoutine,
  type LocalRoutineRun,
  type RoutineDraft,
  type RoutineModel,
  type RoutineProposal,
} from '../../../shared/routines'
import { hostApi, useHostId } from '@/lib/hosts/host-context'
import { chatProviderChoices } from '@/components/chat/account-pool'
import { modelDisplayName } from '@/components/chat/model-search'
import { toast } from '@/components/ui/toaster'
import { ToolCallCard } from '@/components/chat/ToolCallCard'
import {
  formatHHMM,
  formatRelative,
  formatUpcomingDay,
  formatWhen,
} from '@/lib/routines/relative-time'
import {
  scheduleBigTime,
  scheduleSummary,
  scheduleUnitLabel,
  upcomingRunDates,
  type RoutineTranslator,
} from '@/lib/routines/schedule-text'
import type { RoutineModelDisplayInfo } from '@/lib/routines/use-routines'
import {
  RoutineModelLine,
  RoutineOutcomePill,
  RoutinePermBadge,
} from './RoutineOutcomeBadge'

type ToolPart = Extract<MessagePart, { type: 'tool' }>

export function parseRoutineProposeOutput(output: ToolOutput | undefined): string | null {
  const text = toolOutputText(output).trim()
  if (!text) return null
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as { ok?: unknown; proposalId?: unknown }
      if (parsed.ok === true && typeof parsed.proposalId === 'string' && parsed.proposalId.trim()) {
        return parsed.proposalId.trim()
      }
      return null
    } catch {
      return null
    }
  }
  const match = /^Proposal\s+([^\s.]+)\s+created\b/.exec(text)
  return match ? match[1] : null
}

export type ChatTimelineEntry =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'menu-routine'; routine: LocalRoutine }

export function interleaveChatMenuRoutines(
  messages: readonly ChatMessage[],
  menuRoutines: readonly LocalRoutine[]
): ChatTimelineEntry[] {
  if (menuRoutines.length === 0) {
    return messages.map((message) => ({ kind: 'message', message }))
  }
  const sortedRoutines = [...menuRoutines].sort((a, b) => a.createdAt - b.createdAt)
  const out: ChatTimelineEntry[] = []
  let rIdx = 0
  for (const message of messages) {
    while (rIdx < sortedRoutines.length && sortedRoutines[rIdx].createdAt <= message.createdAt) {
      out.push({ kind: 'menu-routine', routine: sortedRoutines[rIdx] })
      rIdx += 1
    }
    out.push({ kind: 'message', message })
  }
  while (rIdx < sortedRoutines.length) {
    out.push({ kind: 'menu-routine', routine: sortedRoutines[rIdx] })
    rIdx += 1
  }
  return out
}

function notifyKey(notify: RoutineDraft['notify']): string {
  if (notify === 'all') return 'schedule.notifyAll'
  if (notify === 'none') return 'schedule.notifyNone'
  return 'schedule.notifyNotable'
}

function modelTagText(
  model: RoutineModel,
  modelInfo: RoutineModelDisplayInfo,
  tChat: (key: string) => string
): string {
  const name = modelInfo.name || modelDisplayName(model.modelId)
  if (model.reasoning === 'off') return name
  const effort =
    model.reasoning === 'maestrly-ultra' ? tChat('reasoning.ultra') : model.reasoning
  return `${name} · ${effort}`
}

export function RoutineProposalCardBody({
  proposal,
  routine,
  lastRun,
  backgroundEnabled,
  viaMenu = false,
  readOnly = false,
  busy = false,
  modelInfo,
  onEnableBackground,
  onCreate,
  onAdjust,
  onDiscard,
  onRestore,
  onOpenRoutine,
}: {
  proposal: RoutineProposal
  routine: LocalRoutine | null
  lastRun: LocalRoutineRun | null
  backgroundEnabled: boolean
  viaMenu?: boolean
  readOnly?: boolean
  busy?: boolean
  modelInfo: RoutineModelDisplayInfo
  onEnableBackground: () => void
  onCreate: () => void
  onAdjust: () => void
  onDiscard: () => void
  onRestore: () => void
  onOpenRoutine: (routineId: string) => void
}) {
  const { t } = useTranslation('routines')
  const { t: tChat } = useTranslation('chat')
  const tr: RoutineTranslator = (key, opts) => String(t(key as never, opts as never))
  const now = Date.now()

  if (proposal.state === 'discarded') {
    return (
      <div className="routine-rcard discarded" data-testid="routine-proposal-discarded">
        <div className="routine-rcard-min">
          <X aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {t('proposal.discarded', { title: proposal.draft.title })}
          </span>
          {!readOnly && (
            <button
              type="button"
              disabled={busy}
              onClick={onRestore}
              className="rounded-md px-2 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground disabled:opacity-50"
            >
              {t('proposal.undo')}
            </button>
          )}
        </div>
      </div>
    )
  }

  if (proposal.state === 'created') {
    if (!routine) {
      return (
        <div className="routine-rcard discarded" data-testid="routine-proposal-deleted">
          <div className="routine-rcard-min">
            <Trash2 aria-hidden="true" className="size-3.5 shrink-0" />
            <span>{t('proposal.deleted')}</span>
          </div>
        </div>
      )
    }

    const nextWhen = routine.enabled && routine.nextRunAt ? routine.nextRunAt : null

    return (
      <div className="routine-rcard created" data-testid="routine-proposal-created">
        <div className="routine-rcard-top">
          <div className="routine-rcard-time">
            {scheduleBigTime(routine.schedule)}
            <small>{scheduleUnitLabel(routine.schedule, tr)}</small>
          </div>
          <div className="routine-rcard-eyebrow">
            <CircleCheck aria-hidden="true" className="size-3 shrink-0" />
            <span>{viaMenu ? t('proposal.createdViaMenuEyebrow') : t('proposal.createdEyebrow')}</span>
          </div>
          <div className="routine-rcard-title">{routine.title}</div>
          <div className="routine-rcard-next">
            <RoutinePermBadge mode={routine.permMode} />
            <span className="routine-tag">
              {modelTagText(routine.model, modelInfo, (k) => String(tChat(k as never)))}
            </span>
          </div>
        </div>
        <div className="routine-rcard-done">
          {nextWhen ? (
            <span>
              {t('proposal.next')}{' '}
              <span className="font-mono">{formatWhen(nextWhen, now, tr)}</span>{' '}
              <span className="text-[rgba(154,149,140,0.58)]">· {formatRelative(nextWhen, now, tr)}</span>
            </span>
          ) : (
            <span className="routine-pill routine-tone-skip">{t('proposal.paused')}</span>
          )}
          {lastRun && (
            <>
              <span className="text-[rgba(154,149,140,0.58)]">·</span>
              <span className="inline-flex items-center gap-1.5">
                {t('proposal.last')} <RoutineOutcomePill status={lastRun.status} short />
              </span>
            </>
          )}
          {!readOnly && (
            <button
              type="button"
              onClick={() => onOpenRoutine(routine.id)}
              className="ml-auto inline-flex items-center gap-1 rounded-[7px] border border-border-strong bg-white/[0.04] px-2.5 py-1 text-[12px] font-medium text-foreground transition-colors hover:bg-white/[0.09]"
            >
              <span>{t('proposal.openRoutine')}</span>
              <ArrowUpRight aria-hidden="true" className="size-3.5" />
            </button>
          )}
        </div>
      </div>
    )
  }

  const draft = proposal.draft
  const firstLine = draft.instruction.split('\n')[0] ?? draft.instruction
  const isLong = draft.instruction.includes('\n') || draft.instruction.length > 140
  const nextDates = upcomingRunDates(draft.schedule, 3, now)
  const scheduleKindLabel =
    draft.schedule.kind === 'weekly' ? t('proposal.kindWeekly') : t('proposal.kindInterval')
  const tzSuffix =
    draft.schedule.kind === 'weekly' && draft.schedule.timezone ? ` · ${draft.schedule.timezone}` : ''

  return (
    <div
      className="routine-rcard"
      role="group"
      aria-label={t('proposal.ariaLabel')}
      data-testid="routine-proposal-pending"
    >
      <div className="routine-rcard-top">
        <div className="routine-rcard-time">
          {scheduleBigTime(draft.schedule)}
          <small>{scheduleUnitLabel(draft.schedule, tr)}</small>
        </div>
        <div className="routine-rcard-eyebrow">
          <Clock aria-hidden="true" className="size-3 shrink-0" />
          <span>{t('proposal.waitingEyebrow')}</span>
        </div>
        <div className="routine-rcard-title">{draft.title}</div>
        <div className="routine-rcard-sched">
          {scheduleKindLabel} · {scheduleSummary(draft.schedule, tr)}
          {tzSuffix}
        </div>
        {nextDates.length > 0 && (
          <div className="routine-rcard-next col-start-2 max-[560px]:col-start-1">
            <span className="mr-0.5 text-[11px] text-[rgba(154,149,140,0.58)]">{t('proposal.upcoming')}</span>
            {nextDates.map((d) => (
              <span key={d.getTime()} className="routine-tag">
                {formatUpcomingDay(d.getTime(), Date.now(), tr)} {formatHHMM(d.getTime())}
              </span>
            ))}
          </div>
        )}
      </div>

      <dl className="routine-facts">
        <dt>{t('proposal.factInstruction')}</dt>
        <dd>
          {isLong ? (
            <details className="routine-instr">
              <summary>
                <span className="routine-clamp">{firstLine}</span>{' '}
                <span className="routine-more-toggle">{t('proposal.showAll')}</span>
              </summary>
              <div className="routine-full">{draft.instruction}</div>
            </details>
          ) : (
            <span className="whitespace-pre-wrap">{draft.instruction}</span>
          )}
        </dd>
        <dt>{t('proposal.factPermissions')}</dt>
        <dd>
          <RoutinePermBadge mode={draft.permMode} />
          <span className="routine-sub">{t(`permMode.${draft.permMode}Routine` as never)}</span>
        </dd>
        <dt>{t('proposal.factModel')}</dt>
        <dd>
          <RoutineModelLine
            model={draft.model}
            modelName={modelInfo.name}
            providerName={modelInfo.providerName}
          />
        </dd>
        <dt>{t('proposal.factNotify')}</dt>
        <dd>{tr(notifyKey(draft.notify))}</dd>
      </dl>

      {!backgroundEnabled && !readOnly && (
        <div className="routine-rcard-warn">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-[var(--artifact-warn)]" />
          <span className="min-w-0 flex-1">{t('proposal.bgWarning')}</span>
          <button
            type="button"
            disabled={busy}
            onClick={onEnableBackground}
            className="shrink-0 rounded-[7px] border border-border-strong bg-white/[0.04] px-2.5 py-1 text-[12px] font-medium text-foreground transition-colors hover:bg-white/[0.09] disabled:opacity-50"
          >
            {t('proposal.bgEnable')}
          </button>
        </div>
      )}

      <div className="routine-rcard-actions">
        {readOnly ? (
          <span className="text-[11.5px] text-muted-foreground">{t('proposal.remoteReadOnly')}</span>
        ) : (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={onCreate}
              className="inline-flex items-center gap-1.5 rounded-[7px] bg-primary px-3 py-1.5 text-[12.5px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              <Check aria-hidden="true" className="size-3.5" />
              <span>{t('proposal.createAction')}</span>
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onAdjust}
              className="inline-flex items-center gap-1.5 rounded-[7px] border border-border-strong bg-white/[0.04] px-2.5 py-1.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-white/[0.09] disabled:opacity-50"
            >
              <Pencil aria-hidden="true" className="size-3.5" />
              <span>{t('proposal.adjustAction')}</span>
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onDiscard}
              className="inline-flex items-center gap-1.5 rounded-[7px] px-2.5 py-1.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground disabled:opacity-50"
            >
              <span>{t('proposal.discardAction')}</span>
            </button>
            <span className="routine-note">{t('proposal.footerNote')}</span>
          </>
        )}
      </div>
    </div>
  )
}

export function RoutineCreatedNotice({
  routine,
  lastRun,
  modelInfo,
  readOnly = false,
  onOpenRoutine,
}: {
  routine: LocalRoutine
  lastRun: LocalRoutineRun | null
  modelInfo: RoutineModelDisplayInfo
  readOnly?: boolean
  onOpenRoutine: (routineId: string) => void
}) {
  const syntheticProposal: RoutineProposal = {
    id: `menu:${routine.id}`,
    conversationId: routine.origin?.conversationId ?? '',
    draft: {
      title: routine.title,
      instruction: routine.instruction,
      schedule: routine.schedule,
      permMode: routine.permMode,
      model: routine.model,
      notify: routine.notify,
      missed: routine.missed,
      retentionDays: routine.retentionDays,
    },
    state: 'created',
    routineId: routine.id,
    createdAt: routine.createdAt,
  }
  const noop = () => {}
  return (
    <RoutineProposalCardBody
      proposal={syntheticProposal}
      routine={routine}
      lastRun={lastRun}
      backgroundEnabled={true}
      viaMenu={true}
      readOnly={readOnly}
      modelInfo={modelInfo}
      onEnableBackground={noop}
      onCreate={noop}
      onAdjust={noop}
      onDiscard={noop}
      onRestore={noop}
      onOpenRoutine={onOpenRoutine}
    />
  )
}

function resolveModelInfo(model: RoutineModel, chatConfig: ChatConfig | null): RoutineModelDisplayInfo {
  const choices = chatConfig ? chatProviderChoices(chatConfig) : []
  const provider = choices.find((p) => p.id === model.providerId)
  return {
    name: modelDisplayName(model.modelId),
    providerName: provider?.name ?? model.providerId,
  }
}

export function RoutineProposalCard({
  part,
  conversationId,
  messageId,
}: {
  part: ToolPart
  conversationId: string
  messageId: string
}) {
  const { t } = useTranslation('routines')
  const hostId = useHostId()
  const readOnly = hostId !== LOCAL_HOST_ID

  if (
    part.state.status === 'pending' ||
    part.state.status === 'running' ||
    part.state.status === 'awaiting-permission'
  ) {
    return (
      <div className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-[12px] text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        <span>{t('proposal.waitingEyebrow')}</span>
      </div>
    )
  }

  const proposalId =
    part.state.status === 'completed' ? parseRoutineProposeOutput(part.state.output) : null
  if (!proposalId) {
    return <ToolCallCard part={part} conversationId={conversationId} messageId={messageId} />
  }

  return <LiveRoutineProposalCard proposalId={proposalId} readOnly={readOnly} />
}

function LiveRoutineProposalCard({
  proposalId,
  readOnly,
}: {
  proposalId: string
  readOnly: boolean
}) {
  const { t } = useTranslation('routines')
  const [proposal, setProposal] = useState<RoutineProposal | null>(null)
  const [routine, setRoutine] = useState<LocalRoutine | null>(null)
  const [lastRun, setLastRun] = useState<LocalRoutineRun | null>(null)
  const [backgroundEnabled, setBackgroundEnabled] = useState(true)
  const [chatConfig, setChatConfig] = useState<ChatConfig | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [nextProposal, settings, cfg] = await Promise.all([
        window.api.routinesGetProposal(proposalId),
        window.api.routinesGetSettings(),
        hostApi(LOCAL_HOST_ID).chatConfig(),
      ])
      setProposal(nextProposal)
      setBackgroundEnabled(settings.keepRunning)
      setChatConfig(cfg)
      if (nextProposal?.state === 'created' && nextProposal.routineId) {
        const [nextRoutine, runPage] = await Promise.all([
          window.api.routinesGet(nextProposal.routineId),
          window.api.routinesListRuns({ routineId: nextProposal.routineId, filter: 'all', limit: 20 }),
        ])
        setRoutine(nextRoutine)
        setLastRun(runPage.runs.find((r) => !isRoutineRunSkipped(r)) ?? null)
      } else {
        setRoutine(null)
        setLastRun(null)
      }
    } catch {
      /* Proposal lookup may be unavailable on remote hosts without local routines. */
    } finally {
      setLoaded(true)
    }
  }, [proposalId])

  useEffect(() => {
    void load()
    return window.api.onRoutinesChanged(() => {
      void load()
    })
  }, [load])

  const modelInfo = useMemo(() => {
    const model = routine?.model ?? proposal?.draft.model
    return model ? resolveModelInfo(model, chatConfig) : { name: '', providerName: '' }
  }, [routine?.model, proposal?.draft.model, chatConfig])

  if (!loaded || !proposal) return null

  const openRoutine = (routineId: string) => {
    window.dispatchEvent(new CustomEvent('maestrly:open-routine', { detail: { routineId } }))
  }

  const handleEnableBackground = async () => {
    setBusy(true)
    try {
      await window.api.routinesSetSettings({ keepRunning: true })
      setBackgroundEnabled(true)
      toast({
        id: 'routine-bg-enabled',
        tone: 'ok',
        icon: 'power',
        title: t('background.toastTitle'),
        description: t('background.toastDesc'),
      })
    } finally {
      setBusy(false)
    }
  }

  const handleCreate = async () => {
    setBusy(true)
    try {
      const created = await window.api.routinesCreateFromProposal(proposal.id)
      const tr: RoutineTranslator = (key, opts) => String(t(key as never, opts as never))
      const nextText = created.nextRunAt
        ? t('toasts.createdNext', { when: formatWhen(created.nextRunAt, Date.now(), tr) })
        : ''
      toast({
        id: `routine-created:${created.id}`,
        tone: 'ok',
        icon: 'check',
        title: t('toasts.createdTitle'),
        description: `${created.title}${nextText}`,
        action: {
          label: t('toasts.createdAction'),
          onClick: () => openRoutine(created.id),
        },
      })
      await load()
    } finally {
      setBusy(false)
    }
  }

  const handleAdjust = () => {
    window.dispatchEvent(
      new CustomEvent('maestrly:adjust-routine-proposal', {
        detail: { proposalId: proposal.id, draft: proposal.draft },
      })
    )
  }

  const handleDiscard = async () => {
    setBusy(true)
    try {
      await window.api.routinesDiscardProposal(proposal.id)
      await load()
    } finally {
      setBusy(false)
    }
  }

  const handleRestore = async () => {
    setBusy(true)
    try {
      await window.api.routinesRestoreProposal(proposal.id)
      await load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <RoutineProposalCardBody
      proposal={proposal}
      routine={routine}
      lastRun={lastRun}
      backgroundEnabled={backgroundEnabled}
      readOnly={readOnly}
      busy={busy}
      modelInfo={modelInfo}
      onEnableBackground={() => void handleEnableBackground()}
      onCreate={() => void handleCreate()}
      onAdjust={handleAdjust}
      onDiscard={() => void handleDiscard()}
      onRestore={() => void handleRestore()}
      onOpenRoutine={openRoutine}
    />
  )
}

export function LiveRoutineCreatedNotice({ routine }: { routine: LocalRoutine }) {
  const hostId = useHostId()
  const readOnly = hostId !== LOCAL_HOST_ID
  const [lastRun, setLastRun] = useState<LocalRoutineRun | null>(null)
  const [chatConfig, setChatConfig] = useState<ChatConfig | null>(null)

  useEffect(() => {
    if (readOnly) return
    let alive = true
    const load = async () => {
      try {
        const [runPage, cfg] = await Promise.all([
          window.api.routinesListRuns({ routineId: routine.id, filter: 'all', limit: 20 }),
          hostApi(LOCAL_HOST_ID).chatConfig(),
        ])
        if (!alive) return
        setLastRun(runPage.runs.find((r) => !isRoutineRunSkipped(r)) ?? null)
        setChatConfig(cfg)
      } catch {
        /* Safe fallback to basic model name when local config is unavailable. */
      }
    }
    void load()
    const off = window.api.onRoutinesChanged(() => void load())
    return () => {
      alive = false
      off()
    }
  }, [routine.id, readOnly])

  const modelInfo = useMemo(() => resolveModelInfo(routine.model, chatConfig), [routine.model, chatConfig])

  return (
    <RoutineCreatedNotice
      routine={routine}
      lastRun={lastRun}
      modelInfo={modelInfo}
      readOnly={readOnly}
      onOpenRoutine={(routineId) =>
        window.dispatchEvent(new CustomEvent('maestrly:open-routine', { detail: { routineId } }))
      }
    />
  )
}
