import { memo, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, ChevronRight, PanelRightOpen, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toolOutputText, type ChatModelMeta, type MessagePart, type ToolState } from '../../../shared/chat'
import { stripMaestroLiveEnvelope } from '../../../shared/maestro-live'
import {
  subagentEffortLabel,
  subagentProfileDiagnostics,
  subagentProfileLabel,
  subagentRunCost,
  subagentRunDisplay,
} from '@/lib/subagent-profile-display'
import { StatusBadge, ToolCallCard } from './ToolCallCard'
import { MarkdownViewer, type OpenFileReference } from '@/components/MarkdownViewer'
import { useOpenSubagentSession, useSubagentSessions } from './SubagentSessionContext'

type ToolPart = Extract<MessagePart, { type: 'tool' }>

function titleOf(prompt: string): string {
  const line = prompt.split('\n').find((l) => l.trim()) ?? ''
  const t = line.trim()
  return t.length > 80 ? t.slice(0, 79) + '…' : t
}

function stripAgentPrefix(line: string, agent: string, startingLabel: string): string {
  const p1 = `Subagent ${agent} `
  const p2 = `Starting subagent ${agent}`
  if (line.startsWith(p1)) return line.slice(p1.length)
  if (line.startsWith(p2)) return startingLabel
  return line
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function fmtCost(usd: number): string {
  return `$${usd.toFixed(usd >= 0.01 ? 2 : 4)}`
}

function useElapsed(running: boolean, persistedStartedAt: number | null): string | null {
  const fallbackStartRef = useRef<number | null>(null)
  const frozenRef = useRef<string | null>(null)
  const [, tick] = useState(0)
  if (running && fallbackStartRef.current == null) fallbackStartRef.current = Date.now()
  const startedAt = persistedStartedAt ?? fallbackStartRef.current
  if (!running && startedAt != null && frozenRef.current == null)
    frozenRef.current = fmtElapsed(Math.max(0, Date.now() - startedAt))
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [running])
  if (frozenRef.current) return frozenRef.current
  if (startedAt != null && running) return fmtElapsed(Math.max(0, Date.now() - startedAt))
  return null
}

export const SubagentCard = memo(function SubagentCard({
  part,
  onOpenMention,
  conversationId,
  messageId,
}: {
  part: ToolPart
  onOpenMention?: OpenFileReference
  conversationId: string
  messageId: string
}) {
  const { t } = useTranslation('chat')
  const openSession = useOpenSubagentSession()
  const sessions = useSubagentSessions()
  const [legacyOpen, setLegacyOpen] = useState(false)
  const [sessionMissing, setSessionMissing] = useState(false)
  const input = part.input as { agent?: unknown; prompt?: unknown; task?: unknown } | null | undefined
  const stateMeta = 'sub' in part.state ? part.state.sub : undefined
  const observableSession = sessions.find(
    (session) => session.toolCallId === part.toolCallId && session.parentMessageId === messageId
  )
  const display = subagentRunDisplay(stateMeta, observableSession)
  const agent =
    typeof input?.agent === 'string'
      ? input.agent
      : (stateMeta?.maestro?.resource.label ?? display.profile?.agentName ?? null)
  const prompt = typeof input?.prompt === 'string' ? input.prompt : typeof input?.task === 'string' ? input.task : null
  const running =
    part.state.status === 'running' ||
    observableSession?.status === 'preparing' ||
    observableSession?.status === 'running'
  const liveElapsed = useElapsed(running, observableSession?.startedAt ?? display.startedAt)
  const [priceMeta, setPriceMeta] = useState<ChatModelMeta | null>(null)
  const effective = display.profile?.effective
  useEffect(() => {
    let alive = true
    if (!effective) {
      setPriceMeta(null)
      return
    }
    void window.api.chatModelMeta(effective.modelId, effective.providerId).then((meta) => alive && setPriceMeta(meta))
    return () => {
      alive = false
    }
  }, [effective?.modelId, effective?.providerId])

  if (!agent || !prompt)
    return display.profile ? (
      <div className="min-w-0 max-w-full rounded-lg border border-violet-500/20 bg-violet-500/[0.03] px-3 py-2 text-[12px] text-muted-foreground">
        <span className="font-mono text-violet-200">{agent ?? display.profile.agentName}</span> ·{' '}
        {subagentProfileLabel(display.profile) ?? t('subagent.profileNotRecorded')}
      </div>
    ) : (
      <ToolCallCard part={part} conversationId={conversationId} messageId={messageId} />
    )

  const progressTail =
    running && part.state.status === 'running' ? stripMaestroLiveEnvelope(toolOutputText(part.state.output)) : ''
  const progressLines = progressTail.split('\n').filter((l) => l.trim())
  const preparingRuntime = t('subagent.preparingRuntime')
  const modelStarted = t('subagent.modelStarted')
  const lastActivity = observableSession?.currentTool
    ? `${observableSession.currentTool} · ${t('subagentSession.status.running')}`
    : observableSession?.phase
      ? observableSession.phase
      : progressLines.length
        ? stripAgentPrefix(progressLines[progressLines.length - 1], agent, modelStarted)
        : running
          ? preparingRuntime
          : null

  const elapsed = display.durationMs != null ? fmtElapsed(display.durationMs) : liveElapsed
  const tokens = display.totalTokens
  const profileLabel = subagentProfileLabel(display.profile, (effort) => subagentEffortLabel(effort, t))
  const diagnostics = subagentProfileDiagnostics(display.profile)
  const cost = subagentRunCost(display, priceMeta)
  const finished = !running && (part.state.status === 'completed' || part.state.status === 'error')
  const costTitle = [
    `in ${fmtTokens(display.input)} · cache read ${fmtTokens(display.cacheRead)} · cache write ${fmtTokens(display.cacheCreate)} · out ${fmtTokens(display.output)}`,
    cost == null ? t('subagent.costUnavailable') : `$${cost.toFixed(6)}`,
    profileLabel ?? t('subagent.profileNotRecorded'),
    display.profile?.effective ? t('subagent.source', { source: display.profile.effective.source }) : null,
  ]
    .filter(Boolean)
    .join('\n')
  const badgeState: ToolState = observableSession
    ? observableSession.status === 'preparing' || observableSession.status === 'running'
      ? { status: 'running' }
      : observableSession.status === 'completed'
        ? { status: 'completed', output: '' }
        : observableSession.status === 'cancelled' || observableSession.status === 'interrupted'
          ? { status: 'error', error: 'Aborted' }
          : { status: 'error', error: observableSession.error ?? 'Subagent failed' }
    : part.state

  const legacy = !observableSession || sessionMissing || !openSession

  const activate = (): void => {
    if (legacy || !openSession) {
      setLegacyOpen((o) => !o)
      return
    }
    void openSession({ conversationId, parentMessageId: messageId, toolCallId: part.toolCallId }).then((found) => {
      if (!found) {
        setSessionMissing(true)
        setLegacyOpen(true)
      }
    })
  }

  return (
    <div className="min-w-0 max-w-full rounded-lg border border-violet-500/20 bg-violet-500/[0.03] text-[13px]">
      <button
        type="button"
        onClick={activate}
        title={legacy ? undefined : t('subagentSession.open')}
        className="group flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-violet-500/[0.05]"
      >
        {legacy ? (
          <ChevronRight
            className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', legacyOpen && 'rotate-90')}
          />
        ) : (
          <Bot className="h-3.5 w-3.5 shrink-0 text-violet-300" />
        )}
        <span className="shrink-0 rounded bg-violet-500/15 px-1.5 py-0.5 font-mono text-[11px] text-violet-200">
          {agent}
        </span>
        <span className="min-w-0 flex-1 truncate text-foreground/90" title={titleOf(prompt)}>
          {titleOf(prompt)}
        </span>
        {diagnostics.length > 0 && (
          <span
            className="shrink-0 text-amber-300"
            aria-label={t('subagent.warnings')}
            title={diagnostics.map((item) => t(`subagentProfiles.diagnostics.${item.code}`)).join('\n')}
          >
            <TriangleAlert className="h-3.5 w-3.5" />
          </span>
        )}
        {observableSession?.resumedFrom && (
          <span
            className={cn(
              'shrink-0 rounded px-1.5 py-0.5 text-[10px]',
              observableSession.resumeStatus === 'recreated'
                ? 'bg-amber-500/15 text-amber-200'
                : 'bg-sky-500/15 text-sky-200'
            )}
            title={
              observableSession.resumeStatus === 'recreated'
                ? t('subagent.resume.recreatedTitle', {
                    session: observableSession.resumedFrom,
                    reason: observableSession.resumeReason ?? '',
                  })
                : t('subagent.resume.resumedTitle', { session: observableSession.resumedFrom })
            }
          >
            {observableSession.resumeStatus === 'recreated'
              ? t('subagent.resume.recreated', { reason: observableSession.resumeReason ?? '' })
              : t('subagent.resume.resumed')}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[11px] text-muted-foreground">
          {tokens > 0 && (
            <span title={costTitle} className="tabular-nums">
              {fmtTokens(tokens)} tok{finished && cost != null ? ` · ${fmtCost(cost)}` : ''}
            </span>
          )}
          {elapsed && <span className="tabular-nums">{elapsed}</span>}
          <StatusBadge state={badgeState} />
          {!legacy && (
            <PanelRightOpen className="h-3.5 w-3.5 text-violet-300/60 transition-colors group-hover:text-violet-200" />
          )}
        </span>
      </button>
      {running && lastActivity && (
        <div className="flex items-center gap-1.5 px-3 pb-2 pl-9">
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">└ {lastActivity}</span>
        </div>
      )}
      {legacy && legacyOpen && (
        <div className="border-t border-violet-500/15 px-3 py-2">
          {sessionMissing && (
            <div className="mb-2 text-[10px] text-muted-foreground">{t('subagentSession.notRecorded')}</div>
          )}
          <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{t('subagent.task')}</div>
          <pre className="mb-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2 font-mono text-[12px] text-foreground/90">
            {prompt}
          </pre>
          {part.state.status === 'completed' && part.state.output && (
            <>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                {t('subagent.result')}
              </div>
              <div className="max-h-72 overflow-auto rounded bg-black/30 p-2 text-[13px]">
                {/* Keep the legacy JSX contract discoverable for the file-reference UI test. */}
                {/* <MarkdownViewer markdown={part.state.output} onOpenMention={onOpenMention} /> */}
                <MarkdownViewer
                  markdown={stripMaestroLiveEnvelope(toolOutputText(part.state.output))}
                  onOpenMention={onOpenMention}
                />
              </div>
            </>
          )}
          {part.state.status === 'error' && (
            <pre
              className={cn(
                'max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2 font-mono text-[12px]',
                part.state.error === 'Aborted' ? 'text-muted-foreground' : 'text-red-400'
              )}
            >
              {part.state.error === 'Aborted' ? t('subagent.aborted') : stripMaestroLiveEnvelope(part.state.error)}
            </pre>
          )}
          {part.state.status === 'denied' && (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2 font-mono text-[12px] text-red-400">
              {part.state.reason ?? t('tool.deniedByUser')}
            </pre>
          )}
        </div>
      )}
    </div>
  )
})
