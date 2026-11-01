import { useTranslation } from 'react-i18next'
import type { FleetBot, FleetEnvironment } from '@maestrly/bot-fleet-protocol'
import { diskSize, environmentDiskBytes, environmentDiskSegments } from '@/lib/fleet/format'

/** What the environment takes on disk, by what it holds: its bots, Downloads, its server folder and the rest. */
export function EnvironmentDisk({ environment, bots }: { environment: FleetEnvironment; bots: FleetBot[] }) {
  const { t, i18n } = useTranslation('fleet')
  const total = environmentDiskBytes(environment)
  const segments = environmentDiskSegments(environment, bots)
  const measuredAt = environment.storage?.measuredAt ?? null
  return (
    <div className="space-y-2" data-testid="environment-disk">
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
        <span className="min-w-14 text-[12.5px] text-foreground/75">{t('server.disk')}</span>
        <div
          role="img"
          aria-label={t('environment.disk.label')}
          className="flex h-1.5 min-w-32 flex-1 overflow-hidden rounded-full bg-white/[0.07]"
        >
          {segments.map((segment) => (
            <span
              key={`${segment.kind}:${segment.id}`}
              style={{ width: `${segment.fraction * 100}%`, background: segment.tint }}
            />
          ))}
        </div>
        <span className="font-mono text-[12.5px] tabular-nums text-foreground/75">
          {total === null ? '—' : diskSize(total)}
        </span>
      </div>
      {measuredAt ? (
        <>
          <p className="flex flex-wrap gap-x-5 gap-y-1.5 text-[12.5px] text-muted-foreground">
            {segments.map((segment) => (
              <span key={`${segment.kind}:${segment.id}`}>
                <i className="mr-1 inline-block size-2 rounded-full" style={{ background: segment.tint }} />
                {segment.kind === 'bot' ? segment.name : t(`environment.disk.${segment.kind}`)}
                <b className="ml-1.5 font-mono font-medium tabular-nums text-foreground/75">
                  {diskSize(segment.bytes)}
                </b>
                {segment.browserBytes > 0 && (
                  <span className="ml-1.5 text-xs">
                    {t('environment.disk.browser', { size: diskSize(segment.browserBytes) })}
                  </span>
                )}
              </span>
            ))}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('environment.disk.note', { time: new Date(measuredAt).toLocaleString(i18n.language) })}
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{t('environment.disk.notMeasured')}</p>
      )}
    </div>
  )
}
