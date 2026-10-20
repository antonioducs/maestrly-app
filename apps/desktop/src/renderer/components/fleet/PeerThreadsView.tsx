import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowRightLeft, Check, Clock, Folder, Loader2, Pin, Trash2, User, X } from 'lucide-react'
import type { FleetBot, FleetPeerThread, FleetPeerThreadSettings } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import { UNKNOWN_BOT_TINT } from '@/lib/fleet/selectors'
import { emptyThreads } from '@/lib/fleet/state'
import { threadExpiresInDays, threadGroups, threadSettingsOf, threadState, threadWorking } from '@/lib/fleet/threads'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { cn } from '@/lib/utils'
import { PeerThreadConversation } from './PeerThreadConversation'
import { useFleetServerId } from '@/lib/fleet/server-context'

const RETENTION_DAYS = [30, 60, 90] as const
const HOP_LIMITS = [4, 8, 16] as const

/** A bot's settings for its conversations with other bots: saved as each one changes. */
function ThreadSettingsDialog({ bot, open, onClose }: { bot: FleetBot; open: boolean; onClose: () => void }) {
  const serverId = useFleetServerId()
  const { t } = useTranslation('fleet')
  const [settings, setSettings] = useState<FleetPeerThreadSettings>(() => threadSettingsOf(bot))
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Read when the dialog opens: a bot update while it is open must not undo a choice.
  const currentRef = useRef(threadSettingsOf(bot))
  currentRef.current = threadSettingsOf(bot)
  useEffect(() => {
    if (open) {
      setSettings(currentRef.current)
      setSaved(false)
      setError(null)
    }
  }, [open])
  const save = async (next: FleetPeerThreadSettings) => {
    const previous = settings
    setSettings(next)
    setSaved(false)
    setError(null)
    try {
      await window.api.fleetSetPeerThreadSettings(serverId, bot.id, next)
      setSaved(true)
    } catch (cause) {
      setSettings(previous)
      setError(fleetErrorMessage(cause))
    }
  }
  const segment = (selected: boolean) =>
    cn(
      'h-7 rounded-md px-3 text-[12.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      selected ? 'bg-white/[0.08] text-foreground' : 'text-muted-foreground hover:text-foreground'
    )
  const group = 'mt-2 inline-flex flex-wrap gap-0.5 rounded-lg border border-border bg-white/[0.03] p-0.5'
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('threads.settings.title')}</DialogTitle>
          <DialogDescription>{t('threads.settings.description', { name: bot.name })}</DialogDescription>
        </DialogHeader>
        <div className="divide-y divide-border text-sm">
          <div className="pb-3">
            <p className="font-medium">{t('threads.settings.retentionLabel')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('threads.settings.retentionHint')}</p>
            <div role="radiogroup" aria-label={t('threads.settings.retentionLabel')} className={group}>
              {[...RETENTION_DAYS, null].map((days) => (
                <button
                  key={String(days)}
                  type="button"
                  role="radio"
                  aria-checked={settings.retentionDays === days}
                  className={segment(settings.retentionDays === days)}
                  onClick={() => void save({ ...settings, retentionDays: days })}
                >
                  {days === null ? t('threads.settings.never') : t('threads.settings.days', { count: days })}
                </button>
              ))}
            </div>
          </div>
          <div className="pt-3">
            <p className="font-medium">{t('threads.settings.hopsLabel')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('threads.settings.hopsHint')}</p>
            <div role="radiogroup" aria-label={t('threads.settings.hopsLabel')} className={group}>
              {HOP_LIMITS.map((hopLimit) => (
                <button
                  key={hopLimit}
                  type="button"
                  role="radio"
                  aria-checked={settings.hopLimit === hopLimit}
                  className={segment(settings.hopLimit === hopLimit)}
                  onClick={() => void save({ ...settings, hopLimit })}
                >
                  {t('threads.settings.hops', { count: hopLimit })}
                </button>
              ))}
            </div>
          </div>
        </div>
        <p className="mt-1 flex gap-2 rounded-lg bg-white/[0.03] px-3 py-2.5 text-xs text-muted-foreground">
          <Folder aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {t('threads.settings.note', { name: bot.name })}
        </p>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="mt-1 flex items-center justify-end gap-3">
          {saved && (
            <span role="status" className="mr-auto inline-flex items-center gap-1 text-xs text-emerald-300">
              <Check aria-hidden="true" className="size-3" />
              {t('threads.settings.saved')}
            </span>
          )}
          <Button size="sm" onClick={onClose}>
            {t('threads.settings.close')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** What deleting a thread's conversation removes and what it keeps, before the owner confirms. */
function DeleteThreadDialog({
  bot,
  thread,
  onCancel,
  onConfirm,
}: {
  bot: FleetBot
  thread: FleetPeerThread | null
  onCancel: () => void
  onConfirm: (thread: FleetPeerThread) => void
}) {
  const { t } = useTranslation('fleet')
  return (
    <Dialog open={thread !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('threads.delete.title')}</DialogTitle>
          {thread && (
            <DialogDescription>
              {t('threads.detail.with', { name: bot.name, peer: thread.peer.name })} · {thread.title}
            </DialogDescription>
          )}
        </DialogHeader>
        <ul className="space-y-2.5 text-[13px] text-foreground/85">
          <li className="flex gap-2.5">
            <X aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-red-300" />
            <span>
              {t('threads.delete.goes', { name: bot.name, peer: thread?.peer.name ?? '' })}
              <span className="block text-xs text-muted-foreground">
                {t('threads.delete.goesDetail', { name: bot.name })}
              </span>
            </span>
          </li>
          <li className="flex gap-2.5">
            <Check aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-emerald-300" />
            <span>{t('threads.delete.staysFiles', { name: bot.name })}</span>
          </li>
          <li className="flex gap-2.5">
            <Check aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-emerald-300" />
            <span>{t('threads.delete.staysReport', { name: bot.name })}</span>
          </li>
        </ul>
        <div className="mt-2 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t('threads.delete.cancel')}
          </Button>
          <Button size="sm" variant="destructive" onClick={() => thread && onConfirm(thread)}>
            {t('threads.delete.confirm')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** One thread in the list: the other bot, the subject, where it stands, and what needs the owner. */
function ThreadRow({
  bot,
  thread,
  peerTint,
  selected,
  fresh,
  onOpen,
}: {
  bot: FleetBot
  thread: FleetPeerThread
  peerTint: string
  selected: boolean
  fresh: boolean
  onOpen: () => void
}) {
  const { t, i18n } = useTranslation('fleet')
  const state = threadState(thread, bot)
  const at = new Date(thread.lastActivityAt)
  const time =
    Date.now() - at.getTime() < 86_400_000
      ? at.toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })
      : at.toLocaleDateString(i18n.language, { day: 'numeric', month: 'short' })
  const expires = threadExpiresInDays(thread, Date.now())
  const summary =
    state === 'working'
      ? threadWorking(thread, bot)
        ? t('threads.summary.working', { name: bot.name })
        : t('threads.summary.peerWorking', { peer: thread.peer.name })
      : state === 'deleted'
        ? t('threads.summary.deleted')
        : (thread.report ?? null)
  const meta: Array<{ key: string; icon?: typeof Check; text: string; className?: string }> = [
    ...(thread.origin === 'primary' ? [{ key: 'asked', icon: User, text: t('threads.meta.asked') }] : []),
    ...(state === 'paused'
      ? [{ key: 'needs', icon: AlertTriangle, text: t('threads.state.paused'), className: 'text-amber-300' }]
      : []),
    { key: 'messages', text: t('threads.messages', { count: thread.messages }) },
    ...(thread.pinned ? [{ key: 'pinned', icon: Pin, text: t('threads.meta.kept'), className: 'text-sky-300' }] : []),
    ...(expires !== null && expires <= 7 && state !== 'deleted'
      ? [
          {
            key: 'expires',
            icon: Clock,
            text: expires === 0 ? t('threads.meta.expiresToday') : t('threads.meta.expires', { count: expires }),
            className: 'text-amber-300',
          },
        ]
      : []),
  ]
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={selected}
      className={cn(
        'relative flex w-full gap-2.5 py-2.5 pl-3.5 pr-3.5 text-left hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        selected &&
          'bg-white/[0.07] before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded before:bg-sky-400'
      )}
    >
      <span
        aria-hidden="true"
        className="mt-px flex size-6 shrink-0 items-center justify-center rounded-[7px] text-[11px] font-semibold text-white"
        style={{ background: peerTint }}
      >
        {thread.peer.name.charAt(0).toUpperCase()}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[13px] font-medium',
              state === 'deleted' && 'text-muted-foreground'
            )}
          >
            {thread.title}
          </span>
          <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">{time}</span>
        </span>
        <span className="truncate text-[12px] text-muted-foreground">{thread.peer.name}</span>
        {summary && (
          <span
            className={cn(
              'line-clamp-2 text-[12.5px]',
              state === 'working'
                ? 'text-sky-300'
                : state === 'deleted'
                  ? 'text-muted-foreground'
                  : 'text-foreground/75'
            )}
          >
            {summary}
          </span>
        )}
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11.5px] text-muted-foreground">
          {meta.map(({ key, icon: MetaIcon, text, className: metaClass }) => (
            <span key={key} className={cn('inline-flex items-center gap-1', metaClass)}>
              {MetaIcon && <MetaIcon aria-hidden="true" className="size-3" />}
              {text}
            </span>
          ))}
        </span>
      </span>
      {fresh && <span aria-label={t('threads.new')} className="mt-1.5 size-[7px] shrink-0 rounded-full bg-sky-400" />}
    </button>
  )
}

/**
 * A bot's conversations with other bots (`peer-conversations`), each one apart from its conversation with its
 * owner: those that need the owner first, then the ones at work and the others, and the one the owner opened.
 */
export function PeerThreadsView({
  bot,
  fleet,
  selectedThreadId,
  unseen,
  onSelect,
  onOpenBot,
  onOpenScreen,
  onOpenMain,
  visible,
}: {
  bot: FleetBot
  fleet: FleetController
  selectedThreadId: string | null
  /** The threads with something the owner has not seen. */
  unseen: ReadonlySet<string>
  onSelect: (threadId: string | null) => void
  onOpenBot: (id: string) => void
  onOpenScreen: () => void
  onOpenMain: () => void
  visible: boolean
}) {
  const serverId = fleet.serverId
  const { t } = useTranslation('fleet')
  const threadsState = fleet.state.threads[bot.id] ?? emptyThreads
  const { ensureThreads, loadThreads, dispatch } = fleet
  useEffect(() => {
    ensureThreads(bot.id)
  }, [bot.id, ensureThreads])
  const [filter, setFilter] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [deleting, setDeleting] = useState<FleetPeerThread | null>(null)
  const [error, setError] = useState<string | null>(null)
  const peers = useMemo(() => {
    const counts = new Map<string, { id: string; name: string; count: number }>()
    for (const thread of threadsState.threads) {
      const entry = counts.get(thread.peer.botId) ?? { id: thread.peer.botId, name: thread.peer.name, count: 0 }
      entry.count++
      counts.set(thread.peer.botId, entry)
    }
    return [...counts.values()]
  }, [threadsState.threads])
  const shown = useMemo(
    () => (filter ? threadsState.threads.filter((thread) => thread.peer.botId === filter) : threadsState.threads),
    [filter, threadsState.threads]
  )
  const groups = useMemo(() => threadGroups(shown, bot), [bot, shown])
  const selected = threadsState.threads.find((thread) => thread.id === selectedThreadId) ?? null
  const settings = threadSettingsOf(bot)
  const tintOf = (botId: string) =>
    fleet.state.snapshot.bots.find((item) => item.id === botId)?.tint ?? UNKNOWN_BOT_TINT

  const deleteConversation = async (thread: FleetPeerThread) => {
    setError(null)
    try {
      const updated = await window.api.fleetDeletePeerThreadConversation(serverId, bot.id, thread.id)
      dispatch({ type: 'threads.upsert', botId: bot.id, thread: updated })
    } catch (cause) {
      setError(
        String(cause).includes('FLEET_PEER_THREAD_CONFLICT') ? t('threads.delete.conflict') : fleetErrorMessage(cause)
      )
    }
  }

  // One column at a time when the pane is narrow: the list, or the thread opened.
  const rootRef = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const node = rootRef.current
    if (!node) return
    const observer = new ResizeObserver(() => setNarrow(node.clientWidth < 760))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const chip = (selectedChip: boolean) =>
    cn(
      'inline-flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      selectedChip
        ? 'border-border-strong bg-white/[0.07] text-foreground'
        : 'border-border text-muted-foreground hover:text-foreground'
    )

  const list = (
    <div
      className={cn('flex min-h-0 min-w-0 flex-col', !narrow && 'w-[min(372px,42%)] shrink-0 border-r border-border')}
    >
      <div className="border-b border-border px-3.5 pb-2.5 pt-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">{t('threads.title')}</h2>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            title={t('threads.settings.button')}
            className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-lg border border-border-strong px-2.5 text-xs text-foreground hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Clock aria-hidden="true" className="size-3" />
            {settings.retentionDays === null
              ? t('threads.settings.never')
              : t('threads.settings.days', { count: settings.retentionDays })}
          </button>
        </div>
        <p className="mt-1 text-[11.5px] text-muted-foreground">{t('threads.subtitle', { name: bot.name })}</p>
        {peers.length > 1 && (
          <div
            role="group"
            aria-label={t('threads.filters')}
            className="mt-2.5 flex gap-1.5 overflow-x-auto pb-0.5 [mask-image:linear-gradient(90deg,#000_88%,transparent)] [scrollbar-width:none]"
          >
            <button
              type="button"
              aria-pressed={filter === null}
              className={chip(filter === null)}
              onClick={() => setFilter(null)}
            >
              {t('threads.all')}{' '}
              <span className="text-[11px] text-muted-foreground">{threadsState.threads.length}</span>
            </button>
            {peers.map((peer) => (
              <button
                key={peer.id}
                type="button"
                aria-pressed={filter === peer.id}
                className={chip(filter === peer.id)}
                onClick={() => setFilter(peer.id)}
              >
                {peer.name} <span className="text-[11px] text-muted-foreground">{peer.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" role="list">
        {threadsState.error && !threadsState.threads.length && (
          <div role="alert" className="p-4 text-xs text-destructive">
            {t('threads.loadFailed')}{' '}
            <button
              type="button"
              className="text-primary underline"
              onClick={() => void loadThreads(bot.id).catch(() => {})}
            >
              {t('runs.retry')}
            </button>
          </div>
        )}
        {threadsState.loaded && !threadsState.threads.length && (
          <div className="mx-auto max-w-xs px-6 py-10 text-center text-[13px] text-muted-foreground">
            <span className="mx-auto mb-3 flex size-10 items-center justify-center rounded-xl bg-sky-400/10 text-sky-300">
              <ArrowRightLeft aria-hidden="true" className="size-4" />
            </span>
            <p className="mb-1 text-sm font-semibold text-foreground">{t('threads.empty.title')}</p>
            <p>{t('threads.empty.body', { name: bot.name })}</p>
          </div>
        )}
        {!threadsState.loaded && threadsState.loading && (
          <Loader2
            aria-hidden="true"
            className="mx-auto mt-8 size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
          />
        )}
        {groups.map((group) => (
          <div key={group.key} role="listitem">
            <div
              className={cn(
                'sticky top-0 z-[1] bg-chat-canvas/95 px-3.5 pb-1.5 pt-2.5 text-[11px] tracking-wide backdrop-blur',
                group.key === 'needs' ? 'text-amber-300' : 'text-muted-foreground'
              )}
            >
              {t(`threads.group.${group.key}`)}
            </div>
            {group.threads.map((thread) => (
              <ThreadRow
                key={thread.id}
                bot={bot}
                thread={thread}
                peerTint={tintOf(thread.peer.botId)}
                selected={thread.id === selectedThreadId}
                fresh={unseen.has(thread.id) && thread.id !== selectedThreadId}
                onOpen={() => onSelect(thread.id)}
              />
            ))}
          </div>
        ))}
        {threadsState.threads.length > 0 && (
          <p className="mt-1.5 border-t border-border p-3.5 text-[11.5px] leading-relaxed text-muted-foreground">
            {settings.retentionDays === null
              ? t('threads.footerNever', { name: bot.name })
              : t('threads.footer', { name: bot.name, count: settings.retentionDays })}
          </p>
        )}
      </div>
    </div>
  )

  const detail = selected ? (
    <PeerThreadConversation
      key={selected.id}
      bot={bot}
      fleet={fleet}
      thread={selected}
      narrow={narrow}
      visible={visible}
      onBack={() => onSelect(null)}
      onOpenBot={onOpenBot}
      onOpenScreen={onOpenScreen}
      onOpenMain={onOpenMain}
      onDelete={() => setDeleting(selected)}
    />
  ) : (
    <div className="m-auto max-w-sm px-6 py-10 text-center text-[13px] text-muted-foreground">
      <span className="mx-auto mb-3.5 flex size-10 items-center justify-center rounded-xl bg-sky-400/10 text-sky-300">
        <ArrowRightLeft aria-hidden="true" className="size-4" />
      </span>
      <p className="mb-1.5 text-sm font-semibold text-foreground">{t('threads.pick.title')}</p>
      <p>{t('threads.pick.body', { name: bot.name })}</p>
    </div>
  )

  return (
    <div ref={rootRef} className="@container relative flex min-h-0 min-w-0 flex-1">
      {narrow ? (
        selected ? (
          detail
        ) : (
          list
        )
      ) : (
        <>
          {list}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">{detail}</div>
        </>
      )}
      <ThreadSettingsDialog bot={bot} open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <DeleteThreadDialog
        bot={bot}
        thread={deleting}
        onCancel={() => setDeleting(null)}
        onConfirm={(thread) => {
          setDeleting(null)
          void deleteConversation(thread)
        }}
      />
      {error && (
        <div
          role="alert"
          className="absolute bottom-4 left-4 z-20 flex w-[min(340px,calc(100%-2rem))] items-start gap-3 rounded-xl border border-red-400/30 bg-popover px-3 py-2.5 text-[13px] text-red-200 shadow-2xl"
        >
          <Trash2 aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span className="flex-1">{error}</span>
          <button type="button" aria-label={t('runs.notice.dismiss')} onClick={() => setError(null)}>
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}
