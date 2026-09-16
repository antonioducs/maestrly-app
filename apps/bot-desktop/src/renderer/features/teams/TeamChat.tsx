import { useEffect, useRef, useState } from 'react'
import type { Bot, BotInteraction, TeamDetails, TeamMessage, TeamRun, TeamTask } from '@maestrly/host-protocol'
import { Button } from '../../ui'
import { useT } from '../../i18n'
import type { TranslationKey } from '../../i18n/pt-BR'
import { Composer } from '../chat/Composer'
import { InteractionCard } from '../chat/InteractionCard'
import { Markdown } from '../chat/MessageList'
import { useTeamEvents } from './useTeamEvents'
import { TeamActivity, progressOf } from './TeamActivity'

export type TeamChatState = { text: string; clientMessageId?: string; scrollTop: number }
export function createTeamChatState(teamId: string): TeamChatState {
  try {
    const saved = JSON.parse(sessionStorage.getItem(`team:${teamId}`) ?? '{}')
    return { text: saved.text ?? '', clientMessageId: saved.clientMessageId, scrollTop: 0 }
  } catch {
    return { text: '', scrollTop: 0 }
  }
}
const TERMINAL = new Set(['succeeded', 'partial', 'failed', 'cancelled'])
const RUN_LABEL: Record<TeamRun['status'], TranslationKey> = {
  queued: 'teamPlanning',
  planning: 'teamPlanning',
  working: 'teamWorking',
  reviewing: 'teamReviewing',
  waiting_user: 'teamTaskWaiting',
  paused: 'teamPaused',
  needs_attention: 'teamNeedsAttention',
  cancelling: 'teamStopping',
  succeeded: 'teamSucceeded',
  partial: 'teamPartial',
  failed: 'teamFailed',
  cancelled: 'teamCancelled',
}

/**
 * The team conversation: the request, a short progress line, the questions that need a
 * person and one consolidated answer. The detailed work is one click away and never the
 * main screen.
 */
export function TeamChat({
  details,
  bots,
  connected,
  state,
  onDetails,
  onOpenScreen,
  onRefreshed,
}: {
  details: TeamDetails
  bots: Bot[]
  connected: boolean
  state: TeamChatState
  onDetails: () => void
  onOpenScreen?: (botId: string) => void
  onRefreshed?: (details: TeamDetails) => void
}) {
  const t = useT()
  const [, render] = useState(0)
  const [messages, setMessages] = useState<TeamMessage[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [run, setRun] = useState<TeamRun | null>(details.activeRun)
  const [tasks, setTasks] = useState<TeamTask[]>([])
  const [interactions, setInteractions] = useState<BotInteraction[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [stale, setStale] = useState(false)
  const scroll = useRef<HTMLDivElement>(null)
  const alive = useRef(true)
  const teamId = details.team.id
  const names = new Map<string, string>(details.members.map((member) => [member.botId, bots.find((bot) => bot.id === member.botId)?.name ?? '']))
  const active = !!run && !TERMINAL.has(run.status)
  const changed = () => {
    sessionStorage.setItem(`team:${teamId}`, JSON.stringify({ text: state.text, clientMessageId: state.clientMessageId }))
    if (alive.current) render((value) => value + 1)
  }
  const refresh = async (earlier = false) => {
    const [page, inspected] = await Promise.all([
      window.bot.team({ method: 'team.messages.list', params: { teamId, ...(earlier && messages.length ? { before: messages[0].sequence } : {}) } }),
      window.bot.team({ method: 'team.inspect', params: { teamId } }),
    ])
    if (!alive.current) return
    setMessages((current) => {
      const merged = new Map(current.map((message) => [message.id, message]))
      for (const message of page.messages) merged.set(message.id, message)
      return [...merged.values()].sort((a, b) => a.sequence - b.sequence)
    })
    if (earlier || !messages.length) setHasMore(page.hasMore)
    setRun(inspected.activeRun ?? page.runs.at(-1) ?? null)
    onRefreshed?.(inspected)
    const current = inspected.activeRun ?? page.runs.at(-1)
    if (current) {
      const work = await window.bot.team({ method: 'team.tasks.list', params: { runId: current.id } })
      if (!alive.current) return
      setTasks(work.tasks)
      setRun(work.run)
      // Approvals belong to the member that asked; the coordinator never answers for it.
      const pending = await Promise.all(
        [...new Set(work.tasks.map((task) => task.assigneeBotId))].map((botId) =>
          window.bot.bot({ method: 'bot.interactions.list', params: { botId, pendingOnly: true } }).catch(() => [])
        )
      )
      if (alive.current) setInteractions(pending.flat())
    } else {
      setTasks([])
      setInteractions([])
    }
    setStale(false)
    changed()
  }
  useEffect(() => {
    alive.current = true
    if (scroll.current) scroll.current.scrollTop = state.scrollTop
    return () => {
      alive.current = false
    }
  }, [state])
  useEffect(() => {
    if (connected) void refresh().catch((error) => setError(String(error)))
    else setStale(true)
  }, [teamId, connected])
  const events = useTeamEvents(teamId, connected, refresh, (error) => setError(String(error)))
  const send = async () => {
    if (busy || active || !connected || !state.text.trim()) return
    setBusy(true)
    setError('')
    try {
      // After a lost reply the receipt is looked up first; the draft is never sent twice.
      let receipt = state.clientMessageId
        ? await window.bot.team({ method: 'team.messages.lookup', params: { teamId, clientMessageId: state.clientMessageId } })
        : null
      if (!receipt) {
        state.clientMessageId ??= crypto.randomUUID()
        changed()
        receipt = await window.bot.team({
          method: 'team.messages.send',
          params: { teamId, clientMessageId: state.clientMessageId, content: state.text, artifactIds: [] },
        })
      }
      setRun(receipt.run)
      state.text = ''
      state.clientMessageId = undefined
      changed()
      await refresh()
    } catch (error) {
      setError(String(error))
    } finally {
      setBusy(false)
    }
  }
  const stop = async () => {
    if (!run) return
    setBusy(true)
    setError('')
    try {
      const current = await window.bot.team({ method: 'team.run.get', params: { runId: run.id } })
      setRun(await window.bot.team({ method: 'team.run.cancel', params: { runId: run.id, expectedRevision: current.revision, idempotencyKey: crypto.randomUUID() } }))
      await refresh()
    } catch (error) {
      setError(String(error))
    } finally {
      setBusy(false)
    }
  }
  const progress = progressOf(tasks, names, t('teamTaskRunning').toLowerCase(), t('teamPlanning').toLowerCase())
  return (
    <section className="chat team-chat">
      <header className="chat-header" data-status={run?.status}>
        <div>
          <h1>{details.team.name}</h1>
          <p role="status" aria-live="polite">
            <span className="status-dot" />
            {run ? t(RUN_LABEL[run.status]) : t('ready')}
            {progress && <span className="team-progress"> · {progress}</span>}
          </p>
        </div>
        <div className="chat-header-actions">
          {active && (
            <Button disabled={busy || !connected || run?.status === 'cancelling'} onClick={() => void stop()}>
              {t(run?.status === 'cancelling' ? 'teamStopping' : 'teamStop')}
            </Button>
          )}
          <Button onClick={onDetails}>{t('details')}</Button>
        </div>
      </header>
      {stale && !connected && (
        <div className="connection-banner" role="status">
          {t('teamOffline')}
        </div>
      )}
      <div
        className="messages"
        ref={scroll}
        onScroll={(event) => {
          state.scrollTop = event.currentTarget.scrollTop
        }}
      >
        {hasMore && <Button onClick={() => void refresh(true).catch((error) => setError(String(error)))}>{t('previous')}</Button>}
        {!messages.length && (
          <div className="empty-chat">
            <h2>{t('teamEmpty')}</h2>
            <p>{t('teamEmptyText')}</p>
          </div>
        )}
        {messages.map((message) => (
          <article key={message.id} className={`message team-message ${message.author.kind}`}>
            <header>
              {/* Where a message came from is always visible; a delegation is never shown as a person. */}
              <strong>{message.author.kind === 'human' ? t('yourRequest') : message.author.kind === 'bot' ? message.author.name : t('system')}</strong>
              {message.author.kind === 'bot' && message.kind === 'answer' && <small>{t('teamAnswer')}</small>}
            </header>
            {/* Content is rendered through the same sanitizer as bot chat: never raw HTML. */}
            <Markdown text={message.content} />
            {!!message.artifacts.length && (
              <ul className="team-message-files">
                {message.artifacts.map((artifact) => (
                  <li key={artifact.artifactId}>{artifact.name}</li>
                ))}
              </ul>
            )}
          </article>
        ))}
        {interactions.map((interaction) => (
          <InteractionCard key={interaction.id} interaction={interaction} refresh={refresh} disabled={!connected} />
        ))}
        <TeamActivity run={run} tasks={tasks} events={events} names={names} onOpenScreen={onOpenScreen} />
      </div>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      <Composer
        attachments={[]}
        removeAttachment={() => {}}
        value={state.text}
        onChange={(value) => {
          state.text = value
          changed()
        }}
        send={() => void send()}
        stop={() => void stop()}
        attach={() => {}}
        active={active}
        cancelling={run?.status === 'cancelling'}
        disabled={!connected}
        busy={busy}
      />
    </section>
  )
}
