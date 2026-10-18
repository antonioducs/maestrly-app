import { useEffect, useState, type ReactNode } from 'react'
import { History, Loader2, MessageSquare, Monitor, Pause, Play, Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { FleetBot, FleetEnvironment } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { ChatWindowButton } from '@/components/chat/ChatWindowHost'
import { startBot } from '@/lib/fleet/environments'
import { takeoverBlocksResume } from '@/lib/fleet/selectors'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { sideTurns } from '@/lib/fleet/turns'
import { cn } from '@/lib/utils'
import { BotPaneSwitch, type BotPane } from './BotPaneSwitch'

/** Whether the conversation pane shows the bot's conversation or its routine runs. */
export type BotConversationPane = 'conversation' | 'runs'

/** How long the run in progress has worked, as `m:ss`, ticking each second. */
function RunElapsed({ since }: { since: string | null }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  if (!since) return null
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000))
  return (
    <span className="tabular-nums text-sky-300/70">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  )
}

/** The dot before a bot's status: ready, working, waiting for the owner, or at rest. */
export function botStatusDot(status: FleetBot['status']): string {
  return status === 'working'
    ? 'bg-blue-400 animate-pulse motion-reduce:animate-none'
    : status === 'waiting'
      ? 'bg-amber-400'
      : status === 'idle' || status === 'human'
        ? 'bg-status-ready'
        : 'bg-muted-foreground'
}

/** The bot's avatar, name and status line, shared by the headers of both panes. */
export function BotIdentity({
  bot,
  heading = true,
  children,
}: {
  bot: FleetBot
  /** Only one header per view names the bot as the page's heading. */
  heading?: boolean
  children?: ReactNode
}) {
  const { t } = useTranslation('fleet')
  return (
    <>
      <span
        aria-hidden="true"
        className="flex size-[30px] shrink-0 items-center justify-center rounded-[9px] text-[13px] font-semibold text-white"
        style={{ background: bot.tint }}
      >
        {bot.name.charAt(0).toUpperCase()}
      </span>
      <div className="min-w-0 overflow-hidden">
        {heading ? (
          <h1 className="truncate text-sm font-semibold leading-tight">{bot.name}</h1>
        ) : (
          <p className="truncate text-sm font-semibold leading-tight">{bot.name}</p>
        )}
        <p className="mt-px flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11.5px] text-muted-foreground">
          <span className="inline-flex shrink-0 items-center gap-1.5 text-foreground/75">
            <span aria-hidden="true" className={`size-1.5 rounded-full ${botStatusDot(bot.status)}`} />
            {t(`status.${bot.status}`)}
          </span>
          {children}
        </p>
      </div>
    </>
  )
}

const crumb =
  'min-w-0 truncate rounded-sm hover:text-foreground hover:underline hover:underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/**
 * The conversation's header: who the bot is and how it is doing, where it runs, and what can be done with it —
 * pause or resume it, move its conversation to a window of its own, change its settings, and open its computer while
 * that is closed.
 */
export function BotChatHeader({
  bot,
  fleet,
  environment,
  narrow,
  activePane,
  computerOpen,
  onShowPane,
  onOpenComputer,
  onOpenSettings,
  onOpenServer,
  onOpenEnvironment,
  runs,
}: {
  bot: FleetBot
  fleet: FleetController
  environment?: FleetEnvironment
  /** Narrow windows show one pane at a time, switched from here. */
  narrow: boolean
  activePane: BotPane
  computerOpen: boolean
  onShowPane: (pane: BotPane) => void
  onOpenComputer: () => void
  onOpenSettings: () => void
  onOpenServer: () => void
  onOpenEnvironment?: () => void
  /** The bot's routine runs (`routine-conversations`): the tabs between them and its conversation, and the run working. */
  runs?: {
    pane: BotConversationPane
    unseen: number
    onPane: (pane: BotConversationPane) => void
    onOpenRun: (runId: string) => void
  }
}) {
  const { t } = useTranslation('fleet')
  const host = fleet.state.snapshot.host?.hostname ?? t('view.server')
  // The routine runs working now, each in a conversation of its own, beside the bot's own conversation.
  const running = sideTurns(bot).filter((turn) => turn.kind === 'routine')
  const routineLabel = t('transcript.routine.label')
  return (
    <header className="@container flex h-[52px] shrink-0 items-center gap-2.5 pl-4 pr-3">
      <BotIdentity bot={bot}>
        <span aria-hidden="true">·</span>
        <button type="button" onClick={onOpenServer} title={host} className={`max-w-36 ${crumb}`}>
          {host}
        </button>
        {environment && onOpenEnvironment && (
          <>
            <span aria-hidden="true">/</span>
            <button
              type="button"
              onClick={onOpenEnvironment}
              aria-label={t('environment.link', { name: environment.name })}
              title={t('environment.link', { name: environment.name })}
              className={`max-w-36 ${crumb}`}
            >
              {environment.name}
            </button>
          </>
        )}
      </BotIdentity>
      {runs && (
        <div
          role="tablist"
          aria-label={t('runs.title')}
          className="ml-2 inline-flex shrink-0 gap-0.5 rounded-[9px] border border-border bg-white/[0.035] p-0.5"
        >
          {(['conversation', 'runs'] as const).map((pane) => {
            const Icon = pane === 'conversation' ? MessageSquare : History
            const label = t(pane === 'conversation' ? 'runs.tabConversation' : 'runs.tab')
            return (
              <button
                key={pane}
                type="button"
                role="tab"
                aria-selected={runs.pane === pane}
                aria-label={
                  pane === 'runs' && runs.unseen ? `${label} · ${t('runs.newCount', { count: runs.unseen })}` : label
                }
                onClick={() => runs.onPane(pane)}
                className={cn(
                  'inline-flex h-[26px] items-center gap-1.5 rounded-[7px] px-2.5 text-[12.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  runs.pane === pane ? 'bg-white/[0.08] text-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Icon aria-hidden="true" className="size-3.5" />
                <span className={cn(pane === 'conversation' && 'hidden @xl:inline')}>{label}</span>
                {pane === 'runs' && runs.unseen > 0 && (
                  <span className="grid h-[17px] min-w-[17px] place-items-center rounded-full bg-sky-400/20 px-1 text-[10.5px] font-semibold text-sky-300">
                    {runs.unseen}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {runs && running[0] && (
          <button
            type="button"
            onClick={() => runs.onOpenRun(running[0].id)}
            title={
              running.length > 1
                ? t('runs.moreRunning', { titles: running.map((turn) => turn.title || routineLabel).join(', ') })
                : t('runs.runningChip', { title: running[0].title || routineLabel })
            }
            className="mr-1 hidden h-7 max-w-64 items-center gap-1.5 rounded-full border border-sky-400/30 bg-sky-400/[0.08] pl-2 pr-2.5 text-xs text-sky-300 hover:bg-sky-400/[0.14] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring @lg:inline-flex"
          >
            <Loader2 aria-hidden="true" className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />
            <span className="truncate">{running[0].title || routineLabel}</span>
            <RunElapsed since={running[0].startedAt} />
            {running.length > 1 && (
              <span className="shrink-0 rounded-full bg-sky-400/20 px-1.5 text-[10.5px] font-semibold tabular-nums">
                +{running.length - 1}
              </span>
            )}
          </button>
        )}
        {narrow && <BotPaneSwitch active={activePane} onChange={onShowPane} />}
        {bot.status === 'offline' ? (
          <Button size="sm" className="h-[30px]" onClick={() => void startBot(fleet, bot)}>
            {t('action.start')}
          </Button>
        ) : bot.status === 'paused' ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-[30px] text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            disabled={takeoverBlocksResume(bot.takeover)}
            title={takeoverBlocksResume(bot.takeover) ? t('action.resumeBlocked') : undefined}
            onClick={() => void fleet.botAction(bot.id, 'resume')}
          >
            <Play className="size-3.5" />
            {t('action.resume')}
          </Button>
        ) : (
          !['starting', 'human'].includes(bot.status) && (
            <Button
              size="sm"
              variant="ghost"
              className="h-[30px] text-muted-foreground hover:text-foreground"
              onClick={() => void fleet.botAction(bot.id, 'pause')}
            >
              <Pause className="size-3.5" />
              {t('action.pause')}
            </Button>
          )
        )}
        <ChatWindowButton target={{ kind: 'bot', id: bot.id }} />
        <Button
          size="icon"
          variant="ghost"
          className="size-[30px] text-muted-foreground hover:text-foreground"
          aria-label={t('view.settingsButton')}
          title={t('view.settingsButton')}
          onClick={onOpenSettings}
        >
          <Settings />
        </Button>
        {!computerOpen && !narrow && (
          <Button size="sm" variant="outline" className="h-[30px]" onClick={onOpenComputer}>
            <Monitor className="size-3.5" />
            {t('workspace.open')}
          </Button>
        )}
      </div>
    </header>
  )
}
