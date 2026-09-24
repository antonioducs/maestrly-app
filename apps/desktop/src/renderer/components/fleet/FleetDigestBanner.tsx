import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { digestKey, formatDuration } from '@/lib/fleet/forms'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { fleetErrorMessage } from '@/lib/fleet/errors'

export function FleetDigestBanner({
  fleet,
  onOpenBot,
  onOpenServer,
  compact = false,
}: {
  fleet: FleetController
  onOpenBot: (id: string) => void
  onOpenServer: () => void
  compact?: boolean
}) {
  const { t, i18n } = useTranslation('fleet')
  const [error, setError] = useState('')
  const digest = fleet.state.digest
  if (!digest?.entries.length) return null
  const duration = formatDuration(digest.awayMs)
  const lastSeq = Math.max(...digest.entries.map((entry) => entry.seq))
  return (
    <section
      role="region"
      aria-label={t('digest.label')}
      className={`shrink-0 border-b border-border bg-surface-elevated ${compact ? 'p-3 text-xs' : 'px-6 py-4 text-sm'}`}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">{t('digest.title', { duration: t('digest.duration', duration) })}</h2>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void window.api
              .fleetAckDigest(lastSeq)
              .then(() => fleet.dispatch({ type: 'digest', value: null }))
              .catch((cause) => setError(fleetErrorMessage(cause)))
          }
        >
          {t('digest.dismiss')}
        </Button>
      </div>
      <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
        {digest.entries.map((entry) => {
          const bot = fleet.state.snapshot.bots.find((item) => item.id === entry.botId)
          return (
            <li key={entry.seq}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded p-1 text-left hover:bg-accent"
                onClick={() => (entry.botId ? onOpenBot(entry.botId) : onOpenServer())}
              >
                <time className="shrink-0 text-muted-foreground">
                  {new Date(entry.at).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })}
                </time>
                <span
                  className="flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] text-white"
                  style={{ background: bot?.tint ?? '#777' }}
                >
                  {bot?.name.charAt(0) ?? '⌘'}
                </span>
                <span>
                  {bot && <strong>{bot.name} · </strong>}
                  {t(digestKey(entry), { summary: entry.summary ?? '' })}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
