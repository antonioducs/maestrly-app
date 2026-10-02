import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useEnvironmentSettingsResource, useSettingsLifetime } from '@/lib/fleet/environment-settings'
import { SettingsSwitch } from '../SettingsSwitch'
import { SettingsPanel, type EnvironmentSettingsSectionProps } from './shared'
export function EnvironmentComponents({ environment }: EnvironmentSettingsSectionProps) {
  const { t } = useTranslation('fleet')
  const resource = useEnvironmentSettingsResource(environment.id, 'runtimes')
  const [busy, setBusy] = useState(false)
  const lifetime = useSettingsLifetime()
  const active = resource.data?.runtimes.some(
    (r) => r.state === 'checking' || r.state === 'installing' || !!r.pendingVersion
  )
  useEffect(() => {
    if (!active || resource.error) return
    const timer = setInterval(() => {
      if (!busy && !resource.busy && navigator.onLine) void resource.reload()
    }, 2000)
    return () => clearInterval(timer)
  }, [active, busy, resource.busy, resource.error, resource.reload])
  async function act(action: () => Promise<unknown>) {
    const epoch = lifetime.current
    setBusy(true)
    try {
      await action()
      if (epoch === lifetime.current) await resource.reload()
    } catch {
      if (epoch === lifetime.current) resource.setError(true)
    } finally {
      if (epoch === lifetime.current) setBusy(false)
    }
  }
  return (
    <SettingsPanel
      error={resource.error}
      reload={() => void resource.reload()}
      loading={!resource.data && resource.busy}
    >
      {resource.data?.runtimes.map((runtime) => (
        <div key={runtime.id} className="space-y-2 border-b border-border py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-[13px] font-medium">{t(`environmentSettings.runtime.${runtime.id}`)}</h3>
              <p className="text-xs text-muted-foreground">
                {runtime.currentVersion ?? t('environmentSettings.notInstalled')} ·{' '}
                {t(`environmentSettings.runtimeState.${runtime.state}`)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{t('environmentSettings.automatic')}</span>
              <SettingsSwitch
                checked={runtime.automatic}
                disabled={busy}
                label={t('environmentSettings.automatic')}
                onChange={() =>
                  void act(() =>
                    resource.source.setRuntimeAutomatic({
                      id: runtime.id,
                      expectedRevision: runtime.revision,
                      automatic: !runtime.automatic,
                    })
                  )
                }
              />
            </div>
          </div>
          {runtime.availableVersion && (
            <p className="text-xs text-muted-foreground">
              {t('environmentSettings.availableVersion', { version: runtime.availableVersion })}
            </p>
          )}
          {runtime.rollbackVersion && (
            <p className="text-xs text-muted-foreground">
              {t('environmentSettings.rollbackVersion', { version: runtime.rollbackVersion })}
            </p>
          )}
          {runtime.source && (
            <p className="text-xs text-muted-foreground">{t(`environmentSettings.runtimeSource.${runtime.source}`)}</p>
          )}
          {runtime.pendingVersion && (
            <p className="text-xs">{t('environmentSettings.pendingVersion', { version: runtime.pendingVersion })}</p>
          )}
          {runtime.progress !== null && (
            <progress
              className="w-full"
              value={runtime.progress}
              max={100}
              aria-label={t('environmentSettings.progress')}
            />
          )}
          {runtime.error && (
            <p role="alert" className="text-xs text-destructive">
              {t(`environmentSettings.runtimeError.${runtime.error}`)}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {runtime.allowedActions.map((action) => (
              <Button
                key={action}
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    resource.source.runtimeAction({ id: runtime.id, expectedRevision: runtime.revision, action })
                  )
                }
              >
                {t(`environmentSettings.action.${action}`)}
              </Button>
            ))}
          </div>
        </div>
      ))}
    </SettingsPanel>
  )
}
