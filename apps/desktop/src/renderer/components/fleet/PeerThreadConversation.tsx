import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRightLeft,
  Clock,
  CornerDownLeft,
  FileText,
  Film,
  Folder,
  GitBranch,
  Image as ImageIcon,
  Info,
  Loader2,
  Pin,
  Square,
  Trash2,
} from 'lucide-react'
import type { FleetBot, FleetPeerThread } from '@maestrly/bot-fleet-protocol'
import { ChatComposer } from '@/components/chat/ChatComposer'
import { Button } from '@/components/ui/button'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import { UNKNOWN_BOT_TINT } from '@/lib/fleet/selectors'
import { emptyTranscript, runTranscriptKey } from '@/lib/fleet/state'
import { threadExpiresInDays, threadState, threadWorking, type ThreadState } from '@/lib/fleet/threads'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { cn } from '@/lib/utils'
import { LaneTranscript } from './LaneTranscript'
import { PairAvatars } from './PeerThreadBridge'

export const THREAD_PILL: Record<ThreadState, string> = {
  working: 'border-sky-400/30 bg-sky-400/10 text-sky-300',
  paused: 'border-amber-400/30 bg-amber-400/[0.08] text-amber-300',
  open: 'border-border-strong text-muted-foreground',
  deleted: 'border-border-strong text-muted-foreground',
}

/** How many of the bots' messages in a row the thread may still take before it waits for the owner. */
function HopMeter({ thread }: { thread: FleetPeerThread }) {
  const { t } = useTranslation('fleet')
  const used = Math.min(thread.hops, thread.hopLimit)
  const warn = thread.status === 'paused' || used >= thread.hopLimit - 1
  return (
    <span
      className={cn('inline-flex items-center gap-1.5', warn && 'text-amber-300')}
      title={t('threads.detail.hopsTitle', { count: thread.hopLimit })}
    >
      <span aria-hidden="true" className="flex gap-px">
        {Array.from({ length: thread.hopLimit }, (_, index) => (
          <i
            key={index}
            className={cn(
              'block h-2 w-1 rounded-[1px]',
              index < used ? (warn ? 'bg-amber-300' : 'bg-sky-300') : 'bg-white/[0.12]'
            )}
          />
        ))}
      </span>
      <span className="tabular-nums">{t('threads.detail.hops', { used, count: thread.hopLimit })}</span>
    </span>
  )
}

/** What stays of a thread whose conversation was deleted: when, and the files kept in the bot's folder. */
function DeletedThread({ bot, thread }: { bot: FleetBot; thread: FleetPeerThread }) {
  const { t, i18n } = useTranslation('fleet')
  const when = thread.conversationDeletedAt
    ? new Date(thread.conversationDeletedAt).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })
    : ''
  const files = thread.kept?.files ?? []
  return (
    <>
      <div className="flex gap-3 rounded-xl border border-dashed border-border-strong p-4 text-[13px] text-foreground/85">
        <Trash2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div>
          <p>{t('threads.tomb.deleted', { when })}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('threads.tomb.body', { name: bot.name, peer: thread.peer.name })}
          </p>
        </div>
      </div>
      {thread.kept?.folder && (
        <section className="rounded-xl border border-border px-4 py-3 text-[13px]">
          <h3 className="mb-2.5 flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
            <Folder aria-hidden="true" className="size-3.5" />
            {t('threads.tomb.folder', { name: bot.name })}
            <code className="text-foreground/80">{thread.kept.folder}/</code>
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
            <p className="text-xs text-muted-foreground">{t('threads.tomb.noFiles')}</p>
          )}
        </section>
      )}
    </>
  )
}

/** What the bot brought back to the owner's conversation from a thread it opened there. */
export function ThreadReport({ thread, onOpenMain }: { thread: FleetPeerThread; onOpenMain?: () => void }) {
  const { t } = useTranslation('fleet')
  if (!thread.report) return null
  return (
    <section className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.04] px-4 py-3 text-[13px]">
      <h3 className="mb-1.5 flex items-center gap-2 text-xs font-medium text-emerald-300">
        <CornerDownLeft aria-hidden="true" className="size-3.5" />
        {t('threads.report.title')}
        {onOpenMain && (
          <button type="button" className="ml-auto font-normal text-sky-300 hover:underline" onClick={onOpenMain}>
            {t('threads.report.open')}
          </button>
        )}
      </h3>
      <p className="whitespace-pre-wrap text-foreground/85 [overflow-wrap:anywhere]">{thread.report}</p>
    </section>
  )
}

/**
 * One thread with another bot, in this bot's conversation of it: everything the bots said and did there, what it
 * brought back to the owner's conversation, and a composer for the owner to steer it. A thread the bots paused waits
 * here for the owner to write or to let it go on.
 */
export function PeerThreadConversation({
  bot,
  fleet,
  thread,
  narrow,
  visible,
  onBack,
  onOpenBot,
  onOpenScreen,
  onOpenMain,
  onDelete,
}: {
  bot: FleetBot
  fleet: FleetController
  thread: FleetPeerThread
  narrow: boolean
  visible: boolean
  onBack: () => void
  onOpenBot: (id: string) => void
  onOpenScreen: () => void
  onOpenMain: () => void
  onDelete: () => void
}) {
  const serverId = fleet.serverId
  const { t, i18n } = useTranslation('fleet')
  const state = threadState(thread, bot)
  const own = thread.conversation === 'own'
  const working = threadWorking(thread, bot)
  const transcript = fleet.state.runTranscripts[runTranscriptKey(bot.id, thread.id)] ?? emptyTranscript
  const { ensureThreadTranscript, loadThreadTranscript, dispatch } = fleet
  useEffect(() => {
    if (own) ensureThreadTranscript(bot.id, thread.id)
  }, [bot.id, ensureThreadTranscript, own, thread.id])
  const load = useCallback(
    (before?: string | null) => loadThreadTranscript(bot.id, thread.id, before),
    [bot.id, loadThreadTranscript, thread.id]
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [follow, setFollow] = useState(0)
  useEffect(() => {
    setDraft('')
    setError(null)
  }, [thread.id])
  const describe = (cause: unknown) =>
    String(cause).includes('FLEET_PEER_THREAD_CONFLICT')
      ? t('threads.delete.conflict')
      : String(cause).includes('FLEET_PEER_THREADS_UNSUPPORTED')
        ? t('threads.unsupported')
        : fleetErrorMessage(cause)

  const send = async ({ text }: { text: string }) => {
    const value = text.trim()
    if (!value || busy) return
    setBusy(true)
    setError(null)
    try {
      await window.api.fleetSendPeerThreadMessage(serverId, bot.id, thread.id, value)
      setDraft('')
      setFollow((count) => count + 1)
      await load().catch(() => {})
    } catch (cause) {
      setError(describe(cause))
    } finally {
      setBusy(false)
    }
  }
  const patch = async (change: { pinned?: boolean; resume?: true }) => {
    setError(null)
    try {
      const updated = await window.api.fleetPatchPeerThread(serverId, bot.id, thread.id, change)
      dispatch({ type: 'threads.upsert', botId: bot.id, thread: updated })
    } catch (cause) {
      setError(describe(cause))
    }
  }

  const peer = fleet.state.snapshot.bots.find((item) => item.id === thread.peer.botId)
  const peerLook = { name: thread.peer.name, tint: peer?.tint ?? UNKNOWN_BOT_TINT }
  const when = new Date(thread.createdAt).toLocaleString(i18n.language, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
  const origin =
    thread.origin === 'primary'
      ? t('threads.origin.primary')
      : thread.origin === 'side'
        ? t('threads.origin.side', { name: bot.name })
        : t('threads.origin.peer', { peer: thread.peer.name })
  const meta = [origin, when, t('threads.messages', { count: thread.messages })].join(' · ')
  const expires = threadExpiresInDays(thread, Date.now())
  const retention = thread.pinned
    ? t('threads.detail.kept')
    : expires === null
      ? t('threads.detail.never')
      : expires === 0
        ? t('threads.detail.expiresToday')
        : t('threads.detail.expires', { count: expires })
  const action =
    'inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] text-muted-foreground hover:bg-white/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40'

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-14 shrink-0 items-center gap-2.5 border-b border-border py-2 pl-3 pr-2.5">
        {narrow && (
          <button
            type="button"
            onClick={onBack}
            aria-label={t('threads.detail.back')}
            title={t('threads.detail.back')}
            className={action}
          >
            <ArrowLeft className="size-4" />
          </button>
        )}
        <PairAvatars bot={bot} peer={peerLook} />
        <div className="min-w-0 flex-1">
          <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            <span className="truncate">{thread.title}</span>
            <span
              className={cn(
                'inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] font-medium',
                THREAD_PILL[state]
              )}
            >
              {state === 'working' && (
                <Loader2 aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" />
              )}
              {t(`threads.state.${state}`)}
            </span>
          </h2>
          <p className="truncate text-[11.5px] text-muted-foreground">
            <button
              type="button"
              className="hover:text-foreground hover:underline"
              disabled={!peer}
              onClick={() => peer && onOpenBot(peer.id)}
            >
              {t('threads.detail.with', { name: bot.name, peer: thread.peer.name })}
            </button>
            {' · '}
            {meta}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {working && (
            <button
              type="button"
              className={cn(action, 'border border-border-strong text-foreground')}
              // This bot's turn in the thread stops; its other conversations keep working.
              onClick={() =>
                void window.api
                  .fleetCancelTurn(serverId, bot.id, thread.id)
                  .catch((cause) => setError(fleetErrorMessage(cause)))
              }
            >
              <Square aria-hidden="true" className="size-3" />
              {t('threads.actions.stop')}
            </button>
          )}
          {own && (
            <>
              <button
                type="button"
                className={cn(action, thread.pinned && 'text-sky-300')}
                aria-pressed={thread.pinned}
                title={t('threads.actions.pinTitle')}
                onClick={() => void patch({ pinned: !thread.pinned })}
              >
                <Pin aria-hidden="true" className="size-3.5" />
                <span className="hidden @lg:inline">
                  {t(thread.pinned ? 'threads.actions.pinned' : 'threads.actions.pin')}
                </span>
              </button>
              <button
                type="button"
                className={cn(action, 'hover:text-red-300')}
                aria-label={t('threads.actions.delete')}
                title={working ? t('threads.delete.conflict') : t('threads.actions.delete')}
                disabled={working}
                onClick={onDelete}
              >
                <Trash2 aria-hidden="true" className="size-3.5" />
              </button>
            </>
          )}
        </div>
      </div>
      {own && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-sky-400/[0.025] px-4 py-1.5 text-[11.5px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <GitBranch aria-hidden="true" className="size-3" />
            {t('threads.detail.separate')}
          </span>
          <span
            className={cn(
              'inline-flex items-center gap-1.5',
              !thread.pinned && expires !== null && expires <= 7 && 'text-amber-300'
            )}
          >
            {thread.pinned ? (
              <Pin aria-hidden="true" className="size-3" />
            ) : (
              <Clock aria-hidden="true" className="size-3" />
            )}
            {retention}
          </span>
          <HopMeter thread={thread} />
        </div>
      )}
      <LaneTranscript
        bot={bot}
        fleet={fleet}
        laneId={thread.id}
        transcript={transcript}
        live={working}
        visible={visible}
        follow={follow}
        failedText={t('threads.detail.transcriptFailed')}
        placeholder={own ? undefined : <DeletedThread bot={bot} thread={thread} />}
        footer={
          <>
            {thread.peerWorking && (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <ArrowRightLeft aria-hidden="true" className="size-3.5" />
                {t('threads.detail.peerWorking', { peer: thread.peer.name })}
              </p>
            )}
            <ThreadReport thread={thread} onOpenMain={onOpenMain} />
          </>
        }
        onLoad={load}
        onOpenBot={onOpenBot}
        onOpenScreen={onOpenScreen}
        onError={(cause) => setError(fleetErrorMessage(cause))}
      />
      {own && (
        <div className="border-t border-border px-4 py-3">
          <div className="mx-auto max-w-3xl">
            {state === 'paused' && (
              <div
                role="status"
                className="mb-3 flex gap-3 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-3.5 py-3 text-[13px]"
              >
                <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber-300" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-amber-200">{t('threads.paused.title', { count: thread.hopLimit })}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t('threads.paused.body', { name: bot.name, peer: thread.peer.name })}
                  </p>
                  <Button size="sm" variant="outline" className="mt-2 h-7" onClick={() => void patch({ resume: true })}>
                    {t('threads.paused.resume', { count: thread.hopLimit })}
                  </Button>
                </div>
              </div>
            )}
            <ChatComposer
              value={draft}
              onChange={setDraft}
              streaming={false}
              disabled={busy}
              placeholder={t('threads.composer.placeholder', { name: bot.name })}
              onSend={(payload) => void send(payload)}
              onStop={() => {}}
            />
            <p className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
              <Info aria-hidden="true" className="size-3 shrink-0" />
              {t('threads.composer.hint', { name: bot.name, peer: thread.peer.name })}
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
