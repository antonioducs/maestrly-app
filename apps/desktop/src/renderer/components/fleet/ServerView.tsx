import { useTranslation } from 'react-i18next'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { gb } from '@/lib/fleet/format'
export function ServerView({ fleet, onOpenBot }: { fleet: FleetController; onOpenBot: (id: string) => void }) {
  const { t } = useTranslation('fleet')
  const { host, bots } = fleet.state.snapshot
  return (
    <section className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-xl font-semibold">{t('server.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{host?.hostname ?? fleet.state.connection.hostname}</p>
        {fleet.actionError && (
          <p role="alert" className="mt-3 text-xs text-destructive">
            {fleet.actionError.message}
          </p>
        )}
        {host && (
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-lg border border-border p-3">
              <div className="text-xs text-muted-foreground">{t('server.system')}</div>
              {host.os} · {host.arch}
            </div>
            <div className="rounded-lg border border-border p-3">
              <div className="text-xs text-muted-foreground">{t('server.cpu')}</div>
              {host.cpus} · {host.cpuPercent ?? '—'}%
            </div>
            <div className="rounded-lg border border-border p-3">
              <div className="text-xs text-muted-foreground">{t('server.memory')}</div>
              {gb(host.memory.usedBytes)} / {gb(host.memory.totalBytes)} GB
            </div>
            <div className="rounded-lg border border-border p-3">
              <div className="text-xs text-muted-foreground">{t('server.disk')}</div>
              {gb(host.disk.usedBytes)} / {gb(host.disk.totalBytes)} GB
            </div>
            <div className="rounded-lg border border-border p-3">
              <div className="text-xs text-muted-foreground">{t('server.gateway')}</div>
              {host.gatewayVersion}
            </div>
            <div className="rounded-lg border border-border p-3">
              <div className="text-xs text-muted-foreground">{t('server.image')}</div>
              {host.botImageVersion ?? host.botImage}
            </div>
          </div>
        )}
        <h2 className="mt-8 text-sm font-semibold">{t('server.bots')}</h2>
        <div className="mt-3 overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="p-3">{t('server.name')}</th>
                <th className="p-3">{t('server.status')}</th>
                <th className="p-3">{t('server.memory')}</th>
                <th className="p-3">{t('server.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {bots.map((bot) => (
                <tr key={bot.id} className="border-t border-border">
                  <td className="p-3">
                    <button type="button" className="text-primary hover:underline" onClick={() => onOpenBot(bot.id)}>
                      {bot.name}
                    </button>
                  </td>
                  <td className="p-3">{t(`status.${bot.status}`)}</td>
                  <td className="p-3">
                    {bot.resources.memoryBytes === null ? '—' : `${gb(bot.resources.memoryBytes)} GB`}
                  </td>
                  <td className="p-3">
                    <div className="flex gap-3">
                      {(['start', 'stop', 'restart'] as const).map((action) => (
                        <button
                          key={action}
                          type="button"
                          disabled={action === 'start' ? bot.status !== 'offline' : bot.status === 'offline'}
                          className="text-primary disabled:opacity-40"
                          onClick={() => void fleet.botAction(bot.id, action)}
                        >
                          {t(`action.${action}`)}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}
