import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowRightLeft, Check, CornerDownLeft, Loader2, Trash2 } from 'lucide-react'
import type { FleetBot, FleetPeerThread } from '@maestrly/bot-fleet-protocol'
import { threadState } from '@/lib/fleet/threads'
import { cn } from '@/lib/utils'

/** Two bots' initials side by side: the one whose thread it is, and the other one. */
export function PairAvatars({
  bot,
  peer,
}: {
  bot: Pick<FleetBot, 'name' | 'tint'>
  peer: { name: string; tint: string }
}) {
  return (
    <span aria-hidden="true" className="flex shrink-0 -space-x-1.5">
      {[bot, peer].map((who, index) => (
        <span
          key={index}
          className="flex size-6 items-center justify-center rounded-[7px] text-[11px] font-semibold text-white ring-2 ring-chat-canvas"
          style={{ background: who.tint }}
        >
          {who.name.charAt(0).toUpperCase()}
        </span>
      ))}
    </span>
  )
}

/**
 * Where the bot's own conversation shows a message that opened a conversation with another bot: the message goes on
 * there, apart, and what the bot brings back from it shows here.
 */
export function PeerThreadBridge({
  bot,
  peer,
  text,
  at,
  thread,
  onOpen,
}: {
  bot: FleetBot
  peer: { name: string; tint: string }
  /** What the bot sent to open it. */
  text: string
  at: string
  /** The thread, once the app has read the bot's threads; null for one that is gone. */
  thread: FleetPeerThread | null | undefined
  onOpen?: () => void
}) {
  const { t } = useTranslation('fleet')
  const state = thread ? threadState(thread, bot) : thread === null ? 'deleted' : null
  const status =
    state === 'working'
      ? { icon: Loader2, spin: true, text: t('threads.bridge.working'), className: 'text-sky-300' }
      : state === 'paused'
        ? { icon: AlertTriangle, spin: false, text: t('threads.state.paused'), className: 'text-amber-300' }
        : state === 'deleted'
          ? { icon: Trash2, spin: false, text: t('threads.state.deleted'), className: 'text-muted-foreground' }
          : thread?.report
            ? { icon: Check, spin: false, text: t('threads.bridge.answered'), className: 'text-emerald-300' }
            : state === 'open'
              ? {
                  icon: ArrowRightLeft,
                  spin: false,
                  text: t('threads.messages', { count: thread?.messages ?? 0 }),
                  className: 'text-muted-foreground',
                }
              : null
  const StatusIcon = status?.icon
  return (
    <div
      role="group"
      aria-label={t('threads.bridge.title', { peer: peer.name })}
      className="rounded-xl border border-border bg-white/[0.025] text-[13px]"
    >
      <div className="flex items-center gap-3 px-3.5 py-2.5">
        <PairAvatars bot={bot} peer={peer} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{t('threads.bridge.title', { peer: peer.name })}</p>
          <p className="truncate text-xs text-muted-foreground">{thread?.title ?? text}</p>
        </div>
        {status && StatusIcon && (
          <span
            role="status"
            className={cn('hidden shrink-0 items-center gap-1.5 text-xs sm:inline-flex', status.className)}
          >
            <StatusIcon
              aria-hidden="true"
              className={cn('size-3.5', status.spin && 'animate-spin motion-reduce:animate-none')}
            />
            {status.text}
          </span>
        )}
        <button
          type="button"
          disabled={!onOpen || state === 'deleted'}
          onClick={onOpen}
          title={at}
          className="h-7 shrink-0 rounded-md border border-border-strong px-2.5 text-xs hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
        >
          {t('threads.bridge.open')}
        </button>
      </div>
      {thread?.report && (
        <div className="flex gap-2 border-t border-border px-3.5 py-2.5">
          <CornerDownLeft aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-emerald-300" />
          <p className="whitespace-pre-wrap text-foreground/85 [overflow-wrap:anywhere]">{thread.report}</p>
        </div>
      )}
    </div>
  )
}
