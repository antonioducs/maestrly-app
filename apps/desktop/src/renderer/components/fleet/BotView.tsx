import { useTranslation } from 'react-i18next'
import type { KeyboardEvent } from 'react'
import type { FleetBot } from '@maestrly/bot-fleet-protocol'
import type { FleetController } from '@/lib/fleet/use-fleet'
import type { FleetView } from '@/lib/use-main-panels'
import { takeoverBlocksResume } from '@/lib/fleet/selectors'
import { BotConversation } from './BotConversation'
import { BotScreen } from './BotScreen'
import { BotSettings } from './BotSettings'

const tabs = ['conversation', 'screen', 'settings'] as const
export function BotView({
  bot,
  view,
  fleet,
  onView,
  onOpenBot,
}: {
  bot: FleetBot
  view: Extract<FleetView, { kind: 'bot' }>
  fleet: FleetController
  onView: (view: FleetView) => void
  onOpenBot: (id: string) => void
}) {
  const { t } = useTranslation('fleet')
  const tab = view.tab
  const setTab = (next: typeof tab) => onView({ kind: 'bot', botId: bot.id, tab: next })
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = tabs.indexOf(tab)
    const next =
      event.key === 'ArrowRight'
        ? tabs[(index + 1) % tabs.length]
        : event.key === 'ArrowLeft'
          ? tabs[(index + tabs.length - 1) % tabs.length]
          : event.key === 'Home'
            ? tabs[0]
            : event.key === 'End'
              ? tabs[tabs.length - 1]
              : null
    if (!next) return
    event.preventDefault()
    setTab(next)
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#fleet-tab-${next}`)?.focus()
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-border px-5 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-sm font-semibold text-white"
            style={{ background: bot.tint }}
          >
            {bot.name.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 shrink-0">
            <h1 className="truncate text-sm font-semibold">{bot.name}</h1>
            {bot.role && <p className="max-w-32 truncate text-xs text-muted-foreground">{bot.role}</p>}
          </div>
          <button
            type="button"
            onClick={() => onView({ kind: 'server' })}
            className="max-w-36 truncate rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            title={fleet.state.snapshot.host?.hostname ?? t('view.server')}
          >
            {fleet.state.snapshot.host?.hostname ?? t('view.server')}
          </button>
          <div
            role="tablist"
            aria-label={t('view.botTabs')}
            className="flex min-w-0 items-center gap-1 rounded-lg border border-border p-0.5"
          >
            {tabs.map((name) => (
              <button
                key={name}
                id={`fleet-tab-${name}`}
                type="button"
                role="tab"
                aria-selected={tab === name}
                aria-controls={`fleet-panel-${name}`}
                onClick={() => setTab(name)}
                onKeyDown={onKeyDown}
                className={`rounded-md px-3 py-1.5 text-xs focus-visible:ring-2 focus-visible:ring-ring ${tab === name ? 'bg-surface-elevated text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {t(`view.${name}`)}
              </button>
            ))}
          </div>
          <span className="ml-auto shrink-0 rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">
            {t(`status.${bot.status}`)}
          </span>
          {bot.status === 'offline' ? (
            <button
              type="button"
              onClick={() => void fleet.botAction(bot.id, 'start')}
              className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground"
            >
              {t('action.start')}
            </button>
          ) : bot.status === 'paused' ? (
            <button
              type="button"
              disabled={takeoverBlocksResume(bot.takeover)}
              title={takeoverBlocksResume(bot.takeover) ? t('action.resumeBlocked') : undefined}
              onClick={() => void fleet.botAction(bot.id, 'resume')}
              className="rounded-md border border-border px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('action.resume')}
            </button>
          ) : (
            !['starting', 'human'].includes(bot.status) && (
              <button
                type="button"
                onClick={() => void fleet.botAction(bot.id, 'pause')}
                className="rounded-md border border-border px-3 py-1.5 text-xs"
              >
                {t('action.pause')}
              </button>
            )
          )}
        </div>
      </header>
      {fleet.actionError?.botId === bot.id && (
        <p role="alert" className="px-5 py-2 text-xs text-destructive">
          {fleet.actionError.message}
        </p>
      )}
      <div
        id={`fleet-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`fleet-tab-${tab}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {tab === 'conversation' ? (
          <BotConversation
            key={bot.id}
            bot={bot}
            fleet={fleet}
            onOpenBot={onOpenBot}
            onOpenScreen={() => setTab('screen')}
            onOpenSettings={() => setTab('settings')}
          />
        ) : tab === 'screen' ? (
          <BotScreen key={bot.id} bot={bot} fleet={fleet} onOpenSettings={() => setTab('settings')} />
        ) : (
          <BotSettings
            key={bot.id}
            bot={bot}
            fleet={fleet}
            onOpenScreen={() => setTab('screen')}
            onArchived={() => onView({ kind: 'server' })}
          />
        )}
      </div>
    </div>
  )
}
