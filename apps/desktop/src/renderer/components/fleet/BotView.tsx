import { useTranslation } from 'react-i18next'
import type { KeyboardEvent } from 'react'
import type { FleetBot } from '@maestrly/bot-fleet-protocol'
import type { FleetController } from '@/lib/fleet/use-fleet'
import type { FleetView } from '@/lib/use-main-panels'
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
      <header className="border-b border-border px-5 pt-4">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className="flex size-10 items-center justify-center rounded-xl text-lg font-semibold text-white"
            style={{ background: bot.tint }}
          >
            {bot.name.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold">{bot.name}</h1>
            <p className="truncate text-xs text-muted-foreground">{bot.role}</p>
          </div>
          <button
            type="button"
            onClick={() => onView({ kind: 'server' })}
            className="rounded-full border border-border px-2 py-1 text-xs hover:bg-accent"
          >
            {t('view.server')}
          </button>
          <span className="rounded-full bg-muted px-2 py-1 text-xs">{t(`status.${bot.status}`)}</span>
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
              onClick={() => void fleet.botAction(bot.id, 'resume')}
              className="rounded-md border border-border px-3 py-1.5 text-xs"
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
        <div role="tablist" aria-label={t('view.botTabs')} className="mt-4 flex gap-4">
          {tabs.map((name) => (
            <button
              key={name}
              id={`fleet-tab-${name}`}
              type="button"
              role="tab"
              aria-selected={tab === name}
              aria-controls={`fleet-panel-${name}`}
              tabIndex={tab === name ? 0 : -1}
              onKeyDown={onKeyDown}
              onClick={() => setTab(name)}
              className={`border-b-2 pb-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${tab === name ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            >
              {t(`view.${name}`)}
            </button>
          ))}
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
          />
        ) : tab === 'screen' ? (
          <BotScreen key={bot.id} bot={bot} fleet={fleet} />
        ) : (
          <BotSettings key={bot.id} bot={bot} fleet={fleet} onArchived={() => onView({ kind: 'server' })} />
        )}
      </div>
    </div>
  )
}
