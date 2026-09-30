import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  FLEET_RUNTIME_UPDATES_FEATURE,
  type FleetEnvironment,
  type FleetRuntimeInfo,
} from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { formatCheckedAt, isRuntimeAssetUpdateActive } from '@/components/chat/runtime-asset-presentation'
import type { FleetController } from '@/lib/fleet/use-fleet'

/**
 * The Claude Code and Codex versions an environment runs, which its bots keep current on their own, with a check on
 * demand. Hidden for a gateway or image that does not report them.
 */
export function EnvironmentRuntimes({ environment, fleet }: { environment: FleetEnvironment; fleet: FleetController }) {
  const { t, i18n } = useTranslation('fleet')
  const [busy, setBusy] = useState(false)
  const runtimes = environment.runtimes
  if (!runtimes) return null
  const supported = fleet.state.connection.features.includes(FLEET_RUNTIME_UPDATES_FEATURE)
  const running = environment.lifecycle === 'running'
  const active = runtimes.some((runtime) => isRuntimeAssetUpdateActive(runtime.state))
  const state = (runtime: FleetRuntimeInfo) =>
    runtime.state === 'failed' && runtime.error
      ? t(`environment.runtimes.errors.${runtime.error}`, {
          defaultValue: t('environment.runtimes.state.failed'),
        })
      : t(`environment.runtimes.state.${runtime.state}`, { version: runtime.availableVersion ?? '' })
  async function check() {
    setBusy(true)
    try {
      await fleet.checkEnvironmentRuntimes(environment.id)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="space-y-3" aria-labelledby="fleet-environment-runtimes">
      <h2 id="fleet-environment-runtimes" className="font-semibold">
        {t('environment.runtimes.title')}
      </h2>
      <p className="text-xs text-muted-foreground">{t('environment.runtimes.note')}</p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {runtimes.map((runtime) => (
          <li key={runtime.id} className="space-y-1 px-4 py-3 text-sm" data-fleet-runtime={runtime.id}>
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{t(`environment.runtimes.name.${runtime.id}`)}</span>
              <span className="text-muted-foreground">
                {runtime.version ? `v${runtime.version}` : '—'} · {t(`environment.runtimes.source.${runtime.source}`)}
              </span>
            </p>
            {runtime.pendingVersion && (
              <p className="text-xs text-muted-foreground" data-fleet-runtime-pending>
                {t(`environment.runtimes.pending.${runtime.id}`, { version: runtime.pendingVersion })}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {state(runtime)} ·{' '}
              {runtime.lastCheckedAt
                ? t('environment.runtimes.lastChecked', {
                    time: formatCheckedAt(runtime.lastCheckedAt, i18n.resolvedLanguage || i18n.language),
                  })
                : t('environment.runtimes.neverChecked')}
              {!runtime.automatic && ` · ${t('environment.runtimes.manual')}`}
            </p>
          </li>
        ))}
      </ul>
      <Button
        size="sm"
        variant="outline"
        disabled={!supported || !running || active || busy}
        onClick={() => void check()}
      >
        {t('environment.runtimes.check')}
      </Button>
    </section>
  )
}
