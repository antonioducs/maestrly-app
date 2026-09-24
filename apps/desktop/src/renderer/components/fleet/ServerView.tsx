import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetPeerMessage } from '@maestrly/bot-fleet-protocol'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { gb, memorySegments } from '@/lib/fleet/format'
import { formatDuration } from '@/lib/fleet/forms'

function ResourceBar({ label, fraction, value }: { label: string; fraction: number; value: string }) {
  return (
    <div className="grid grid-cols-[90px_1fr_auto] items-center gap-3 text-sm">
      <span>{label}</span>
      <div
        className="h-2 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label={label}
        aria-valuenow={Math.round(fraction * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full bg-primary" style={{ width: `${Math.min(100, fraction * 100)}%` }} />
      </div>
      <span className="text-xs text-muted-foreground">{value}</span>
    </div>
  )
}

export function ServerView({ fleet, onOpenBot }: { fleet: FleetController; onOpenBot: (id: string) => void }) {
  const { t } = useTranslation('fleet')
  const { host, bots } = fleet.state.snapshot
  const [version, setVersion] = useState('')
  const [messages, setMessages] = useState<FleetPeerMessage[]>(fleet.state.snapshot.peerMessages)
  const [error, setError] = useState('')
  useEffect(() => {
    void window.api
      .getAppInfo()
      .then((info) => setVersion(info.version))
      .catch(() => {})
  }, [])
  useEffect(() => setMessages(fleet.state.snapshot.peerMessages), [fleet.state.snapshot.peerMessages])
  useEffect(() => {
    void window.api
      .fleetGetPeerMessages()
      .then((result) => setMessages(result.messages))
      .catch((cause) => setError(String(cause)))
  }, [])
  const memory = memorySegments(host, bots)
  const uptime = formatDuration((host?.uptimeSeconds ?? 0) * 1000)
  return (
    <section className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl space-y-8">
        <header>
          <h1 className="text-xl font-semibold">{t('server.title')}</h1>
          <p className="text-sm text-muted-foreground">{host?.hostname ?? fleet.state.connection.hostname}</p>
        </header>
        {host && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg border border-border p-4">
                <div className="text-xs text-muted-foreground">{t('server.yourMac')}</div>
                <strong>{t('server.canTurnOff')}</strong>
                <p className="mt-1 text-xs text-muted-foreground">{t('server.macNote')}</p>
              </div>
              <div className="rounded-lg border border-border p-4">
                <div className="text-xs text-muted-foreground">{t('server.server')}</div>
                <strong>{host.hostname}</strong>
                <p className="mt-1 text-xs text-muted-foreground">
                  {host.os} · {host.arch}
                </p>
              </div>
              <div className="rounded-lg border border-border p-4">
                <div className="text-xs text-muted-foreground">{t('server.uptime')}</div>
                <strong>{t('server.uptimeValue', uptime)}</strong>
                <p className="mt-1 text-xs text-muted-foreground">{host.kernel}</p>
              </div>
              <div className="rounded-lg border border-border p-4">
                <div className="text-xs text-muted-foreground">{t('server.version')}</div>
                <strong>
                  {host.gatewayVersion} / {version || '—'}
                </strong>
                <p
                  className={`mt-1 text-xs ${version && version !== host.gatewayVersion ? 'text-destructive' : 'text-muted-foreground'}`}
                >
                  {version && version !== host.gatewayVersion ? t('server.versionMismatch') : t('server.versionMatch')}
                </p>
              </div>
            </div>
            <section>
              <h2 className="mb-3 font-semibold">{t('server.resources')}</h2>
              <div className="space-y-3 rounded-lg border border-border p-4">
                <div className="grid grid-cols-[90px_1fr_auto] items-center gap-3 text-sm">
                  <span>{t('server.memory')}</span>
                  <div
                    className="flex h-2 overflow-hidden rounded-full bg-muted"
                    role="meter"
                    aria-label={t('server.memory')}
                    aria-valuenow={Math.round((host.memory.usedBytes / host.memory.totalBytes) * 100)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    {memory.map((segment) => (
                      <span
                        key={segment.id}
                        style={{ width: `${segment.fraction * 100}%`, background: segment.tint }}
                      />
                    ))}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {gb(host.memory.usedBytes)} / {gb(host.memory.totalBytes)} GB
                  </span>
                </div>
                <p className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                  {memory.map((segment) => (
                    <span key={segment.id}>
                      <i className="mr-1 inline-block size-2 rounded-full" style={{ background: segment.tint }} />
                      {segment.id === 'system' ? t('server.system') : bots.find((bot) => bot.id === segment.id)?.name}
                    </span>
                  ))}
                </p>
                <ResourceBar
                  label={t('server.cpu')}
                  fraction={(host.cpuPercent ?? 0) / 100}
                  value={`${host.cpuPercent ?? '—'}% · ${host.cpus} vCPU`}
                />
                <ResourceBar
                  label={t('server.disk')}
                  fraction={host.disk.totalBytes ? host.disk.usedBytes / host.disk.totalBytes : 0}
                  value={`${gb(host.disk.usedBytes)} / ${gb(host.disk.totalBytes)} GB`}
                />
              </div>
            </section>
          </>
        )}
        <section>
          <h2 className="mb-3 font-semibold">{t('server.bots')}</h2>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  {['name', 'status', 'memory', 'cpu', 'uptime', 'actions'].map((key) => (
                    <th key={key} className="p-3">
                      {t(`server.${key}`)}
                    </th>
                  ))}
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
                    <td className="p-3">{bot.resources.cpuPercent === null ? '—' : `${bot.resources.cpuPercent}%`}</td>
                    <td className="p-3">
                      {bot.resources.startedAt
                        ? t('server.uptimeValue', formatDuration(Date.now() - Date.parse(bot.resources.startedAt)))
                        : '—'}
                    </td>
                    <td className="p-3">
                      <div className="flex gap-2">
                        {(['restart', 'stop', 'start'] as const).map((action) => (
                          <button
                            key={action}
                            type="button"
                            disabled={
                              action === 'start'
                                ? bot.status !== 'offline'
                                : bot.status === 'offline' || bot.status === 'human'
                            }
                            onClick={() => void fleet.botAction(bot.id, action)}
                            className="text-primary disabled:opacity-40"
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
        </section>
        <section>
          <h2 className="mb-3 font-semibold">{t('server.peerMessages')}</h2>
          {messages.length ? (
            <ul className="space-y-2 text-sm">
              {messages.map((message) => (
                <li key={message.id} className="rounded-lg border border-border p-3">
                  <time className="mr-2 text-xs text-muted-foreground">
                    {new Date(message.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                  </time>
                  <strong>{bots.find((bot) => bot.id === message.from)?.name ?? message.from}</strong> →{' '}
                  <strong>{bots.find((bot) => bot.id === message.to)?.name ?? message.to}</strong>
                  <span className="ml-2">{message.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">{t('server.noPeerMessages')}</p>
          )}
        </section>
        <section>
          <h2 className="mb-2 font-semibold">{t('server.howTitle')}</h2>
          <p className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
            {t('server.howDescription')}
          </p>
        </section>
        {(error || fleet.actionError) && (
          <p role="alert" className="text-xs text-destructive">
            {error || fleet.actionError?.message}
          </p>
        )}
      </div>
    </section>
  )
}
