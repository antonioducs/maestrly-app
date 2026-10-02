import type { ReactNode } from 'react'
import { Monitor, Pause, Play, Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { FleetBot, FleetEnvironment } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { startBot } from '@/lib/fleet/environments'
import { takeoverBlocksResume } from '@/lib/fleet/selectors'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { BotPaneSwitch, type BotPane } from './BotPaneSwitch'

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
 * pause or resume it, change its settings, and open its computer while that is closed.
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
}) {
  const { t } = useTranslation('fleet')
  const host = fleet.state.snapshot.host?.hostname ?? t('view.server')
  return (
    <header className="flex h-[52px] shrink-0 items-center gap-2.5 pl-4 pr-3">
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
      <div className="ml-auto flex shrink-0 items-center gap-1">
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
