import { useEffect, useState, type ReactNode } from 'react'
import { ArrowRightLeft, FolderOpen, History, Loader2, MessageSquare, Monitor, Pause, Play, Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { FleetBot, FleetEnvironment, FleetFilesUsage } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { ChatWindowButton } from '@/components/chat/ChatWindowHost'
import { fileSizeLabel } from '@/lib/fleet/downloads'
import { startBot } from '@/lib/fleet/environments'
import { filesLevel, filesMeter } from '@/lib/fleet/files'
import { takeoverBlocksResume } from '@/lib/fleet/selectors'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { sideTurns } from '@/lib/fleet/turns'
import { cn } from '@/lib/utils'
import { BOT_FILES_DRAWER_ID } from './BotFilesDrawer'
import { BotPaneSwitch, type BotPane } from './BotPaneSwitch'

/** Whether the conversation pane shows the bot's conversation, its routine runs or its conversations with other bots. */
export type BotConversationPane = 'conversation' | 'runs' | 'threads'

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
  panes,
  files,
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
  /**
   * The bot's side conversations: its routine runs (`routine-conversations`) and its conversations with other bots
   * (`peer-conversations`), each a tab beside its own conversation when the bot keeps them, and the turns working there.
   */
  panes?: {
    pane: BotConversationPane
    runs: boolean
    threads: boolean
    unseenRuns: number
    /** The conversations with other bots with something new, or waiting for the owner. */
    unseenThreads: number
    onPane: (pane: BotConversationPane) => void
    onOpenRun: (runId: string) => void
    onOpenThread: (threadId: string) => void
  }
  files?: {
    usage: FleetFilesUsage | null
    open: boolean
    onToggle: () => void
  }
}) {
  const { t, i18n } = useTranslation('fleet')
  const host = fleet.state.snapshot.host?.hostname ?? t('view.server')
  // The side conversations working now, each in a conversation of its own, beside the bot's own conversation.
  const running = sideTurns(bot).filter((turn) => (turn.kind === 'routine' ? panes?.runs : panes?.threads))
  const routineLabel = t('transcript.routine.label')
  const turnLabel = (turn: (typeof running)[number]) =>
    turn.title || (turn.kind === 'routine' ? routineLabel : t('threads.tabLabel'))
  const tabs = panes
    ? ([
        'conversation',
        ...(panes.runs ? ['runs'] : []),
        ...(panes.threads ? ['threads'] : []),
      ] as BotConversationPane[])
    : []
  const tabIcon = { conversation: MessageSquare, runs: History, threads: ArrowRightLeft }
  const tabLabel = (pane: BotConversationPane) =>
    t(pane === 'conversation' ? 'runs.tabConversation' : pane === 'runs' ? 'runs.tab' : 'threads.tab')
  const tabCount = (pane: BotConversationPane) =>
    pane === 'runs' ? (panes?.unseenRuns ?? 0) : pane === 'threads' ? (panes?.unseenThreads ?? 0) : 0
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
      {panes && tabs.length > 1 && (
        <div
          role="tablist"
          aria-label={panes.threads ? t('threads.panes', { name: bot.name }) : t('runs.title')}
          className="ml-2 inline-flex shrink-0 gap-0.5 rounded-[9px] border border-border bg-white/[0.035] p-0.5"
        >
          {tabs.map((pane) => {
            const Icon = tabIcon[pane]
            const label = tabLabel(pane)
            const count = tabCount(pane)
            return (
              <button
                key={pane}
                type="button"
                role="tab"
                aria-selected={panes.pane === pane}
                aria-label={
                  count
                    ? `${pane === 'threads' ? t('threads.tabLabel') : label} · ${t(pane === 'runs' ? 'runs.newCount' : 'threads.newCount', { count })}`
                    : pane === 'threads'
                      ? t('threads.tabLabel')
                      : label
                }
                title={pane === 'threads' ? t('threads.tabLabel') : undefined}
                onClick={() => panes.onPane(pane)}
                className={cn(
                  'inline-flex h-[26px] items-center gap-1.5 rounded-[7px] px-2.5 text-[12.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  panes.pane === pane
                    ? 'bg-white/[0.08] text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Icon aria-hidden="true" className="size-3.5" />
                <span className={cn(pane === 'conversation' && 'hidden @xl:inline')}>{label}</span>
                {count > 0 && (
                  <span className="grid h-[17px] min-w-[17px] place-items-center rounded-full bg-sky-400/20 px-1 text-[10.5px] font-semibold text-sky-300">
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {panes && running[0] && (
          <button
            type="button"
            onClick={() =>
              running[0].kind === 'routine' ? panes.onOpenRun(running[0].id) : panes.onOpenThread(running[0].id)
            }
            title={
              running.length > 1
                ? t('runs.moreRunning', { titles: running.map(turnLabel).join(', ') })
                : t(running[0].kind === 'routine' ? 'runs.runningChip' : 'threads.runningChip', {
                    title: turnLabel(running[0]),
                  })
            }
            className="mr-1 hidden h-7 max-w-64 items-center gap-1.5 rounded-full border border-sky-400/30 bg-sky-400/[0.08] pl-2 pr-2.5 text-xs text-sky-300 hover:bg-sky-400/[0.14] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring @lg:inline-flex"
          >
            <Loader2 aria-hidden="true" className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />
            <span className="truncate">{turnLabel(running[0])}</span>
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
        {files && (
          <BotFilesButton
            botName={bot.name}
            usage={files.usage}
            open={files.open}
            locale={i18n.language}
            onToggle={files.onToggle}
          />
        )}
        <ChatWindowButton target={{ kind: 'bot', serverId: fleet.serverId, id: bot.id }} />
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

function BotFilesButton({
  botName,
  usage,
  open,
  locale,
  onToggle,
}: {
  botName: string
  usage: FleetFilesUsage | null
  open: boolean
  locale: string
  onToggle: () => void
}) {
  const { t } = useTranslation('fleet')
  const level = filesLevel(usage)
  const meter = usage && level !== 'ok' ? filesMeter(usage) : null
  const label = usage
    ? t('files.drawer.button', {
        name: botName,
        used: fileSizeLabel(usage.usedBytes, locale),
        quota: fileSizeLabel(usage.quotaBytes, locale),
        count: usage.count,
        max: usage.countMax,
      })
    : t('files.drawer.title')
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-pressed={open}
      aria-controls={BOT_FILES_DRAWER_ID}
      title={label}
      onClick={onToggle}
      className={cn(
        'h-[30px] gap-1.5 px-2.5 text-muted-foreground hover:text-foreground',
        open && 'bg-white/[0.08] text-foreground',
        level === 'full' && 'text-red-300 hover:text-red-200',
        level === 'near' && 'text-amber-300 hover:text-amber-200'
      )}
    >
      <FolderOpen aria-hidden="true" className="size-3.5" />
      <span className="hidden @lg:inline">{t('files.drawer.title')}</span>
      {meter && (
        <span className="inline-flex items-center gap-1 tabular-nums text-[11px]">
          <span aria-hidden="true" className="h-1 w-6 overflow-hidden rounded-full bg-white/[0.12]">
            <i
              className={cn(
                'block h-full rounded-full',
                level === 'full' ? 'bg-red-400' : 'bg-amber-400'
              )}
              style={{ width: `${Math.max(8, Math.round(meter.ratio * 100))}%` }}
            />
          </span>
          <span>{meter.text}</span>
        </span>
      )}
    </Button>
  )
}

