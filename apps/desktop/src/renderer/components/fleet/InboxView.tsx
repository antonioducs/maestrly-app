import { useTranslation } from 'react-i18next'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { BotAvatar } from './BotAvatar'
import { InteractionCard, pendingToTranscript } from './InteractionCard'
export function InboxView({
  fleet,
  onOpenBot,
}: {
  fleet: FleetController
  onOpenBot: (id: string, screen?: boolean) => void
}) {
  const { t, i18n } = useTranslation('fleet')
  return (
    <section className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-xl font-semibold">{t('inbox.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('inbox.description')}</p>
        <div className="mt-6 space-y-4">
          {fleet.state.snapshot.inbox.map(({ botId, interaction }) => (
            <div key={`${botId}:${interaction.id}`} className="rounded-xl border border-border bg-card p-4">
              <div className="mb-3 flex items-center gap-3">
                <BotAvatar
                  bot={fleet.state.snapshot.bots.find((bot) => bot.id === botId) ?? { name: botId, tint: '#777' }}
                  className="size-9 rounded-lg text-sm"
                />
                <button
                  type="button"
                  onClick={() => onOpenBot(botId)}
                  className="mb-2 text-sm font-medium text-primary hover:underline"
                >
                  {fleet.state.snapshot.bots.find((bot) => bot.id === botId)?.name ?? botId}
                </button>
                <time className="ml-auto text-xs text-muted-foreground">
                  {new Date(interaction.at).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })}
                </time>
              </div>
              <InteractionCard
                botId={botId}
                item={pendingToTranscript(interaction)}
                fleet={fleet}
                onOpenScreen={() => onOpenBot(botId, true)}
              />
            </div>
          ))}
          {fleet.state.snapshot.inbox.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('inbox.empty')}</p>
          )}
        </div>
      </div>
    </section>
  )
}
