import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  FLEET_ENVIRONMENT_SETTINGS_FEATURE,
  type FleetEnvironment,
  type FleetBot,
  type FleetSelectionOption,
} from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import {
  compactionFormFrom,
  compactionModelLabel,
  compactionPatch,
  compactionSourceOf,
  sameCompactionConfig,
} from '@/lib/fleet/compaction'
import { contextLimitAvailability, environmentCompactionAvailability } from '@/lib/fleet/provisioning'
import { formatNames } from '@/lib/fleet/environments'
import { fleetErrorText } from '@/lib/fleet/errors'
import type { FleetController } from '@/lib/fleet/use-fleet'
import type { EnvironmentSettingsSectionProps } from './environment-settings/shared'
import { CompactionFields } from './CompactionFields'

/**
 * The compaction model of the environment's bots without one of their own. Its models are those of the environment's
 * accounts, read again when they change (the key of the shared lists), never on resource samples.
 */
export function EnvironmentCompaction({
  environment,
  bots,
  fleet,
  optionsKey,
  onDirtyChange,
}: {
  environment: FleetEnvironment
  bots: FleetBot[]
  fleet: FleetController
  optionsKey: string
  onDirtyChange?: EnvironmentSettingsSectionProps['onDirtyChange']
}) {
  const { t, i18n } = useTranslation('fleet')
  const availability = environmentCompactionAvailability(fleet, environment)
  const ready = availability === 'ready'
  const contextLimit = contextLimitAvailability(fleet, environment)
  const current = environment.compaction
  // Null until the models of this environment are listed.
  const [options, setOptions] = useState<FleetSelectionOption[] | null>(null)
  const [form, setForm] = useState(() => compactionFormFrom(current))
  const [baseline, setBaseline] = useState(current)
  const mounted = useRef(true)
  const writing = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    setForm((previous) => {
      const before = compactionFormFrom(baseline)
      const next = compactionFormFrom(current)
      return Object.fromEntries(
        Object.entries(next).map(([key, value]) => [
          key,
          previous[key as keyof typeof previous] === before[key as keyof typeof before]
            ? value
            : previous[key as keyof typeof previous],
        ])
      ) as typeof previous
    })
    if (sameCompactionConfig(compactionPatch(form), baseline)) setBaseline(current)
  }, [
    current?.providerId,
    current?.modelId,
    current?.reasoning,
    current?.fastMode,
    current?.intervalTokens,
    current?.contextLimitTokens,
  ])
  useEffect(() => {
    if (!ready) return
    let alive = true
    window.api.fleetEnvironmentSelections(environment.id).then(
      (value) => {
        if (!alive) return
        setOptions(value.options)
        setError('')
      },
      (cause: unknown) => {
        if (alive) setError(fleetErrorText(cause, t))
      }
    )
    return () => {
      alive = false
    }
  }, [environment.id, ready, optionsKey])
  const value = compactionPatch(form)
  const dirty = !sameCompactionConfig(value, baseline)
  const users = bots.filter((bot) => compactionSourceOf(bot) === 'environment').map((bot) => bot.name)
  const latest = useRef({ value, dirty, baseline, environment, fleet, ready })
  latest.current = { value, dirty, baseline, environment, fleet, ready }
  const discard = useCallback(() => {
    setForm(compactionFormFrom(latest.current.environment.compaction))
    setBaseline(latest.current.environment.compaction)
    setError('')
    setSaved(false)
  }, [])
  const save = useCallback(async (): Promise<boolean> => {
    const { value, dirty, baseline, environment, fleet, ready } = latest.current
    if (!dirty) return true
    if (!value || writing.current || !ready) return false
    writing.current = true
    setBusy(true)
    setSaved(false)
    setError('')
    try {
      const updated = await window.api.fleetPatchEnvironment(environment.id, {
        compaction: value,
        ...(fleet.state.connection.features.includes(FLEET_ENVIRONMENT_SETTINGS_FEATURE)
          ? { expected: { compaction: baseline } }
          : {}),
      })
      fleet.dispatch({
        type: 'event',
        value: { type: 'environment.updated', at: new Date().toISOString(), environment: updated },
      })
      if (mounted.current) {
        setBaseline(updated.compaction)
        setForm(compactionFormFrom(updated.compaction))
        setSaved(true)
      }
      return true
    } catch (cause) {
      if (mounted.current) setError(fleetErrorText(cause, t))
      return false
    } finally {
      writing.current = false
      if (mounted.current) setBusy(false)
    }
  }, [t])
  useEffect(() => {
    onDirtyChange?.(dirty, save, discard)
  }, [dirty, form, save, discard, onDirtyChange])
  if (availability === 'unsupported') return null
  return (
    <section className="space-y-3" aria-labelledby="fleet-environment-compaction">
      <h2 id="fleet-environment-compaction" className="font-semibold">
        {t('environment.compaction.heading')}
      </h2>
      <p className="text-xs text-muted-foreground">{t('environment.compaction.description')}</p>
      {!current && <p className="text-xs text-muted-foreground">{t('environment.compaction.unset')}</p>}
      {ready ? (
        <>
          <CompactionFields
            form={form}
            onChange={(next) => {
              setForm(next)
              setSaved(false)
            }}
            options={options ?? []}
            idPrefix="fleet-environment-compaction"
            contextLimit={contextLimit === 'unsupported' ? undefined : contextLimit}
          />
          {options?.length === 0 && (
            <p className="text-xs text-muted-foreground">{t('environment.compaction.noModels')}</p>
          )}
          <div className="flex items-center gap-3">
            <Button size="sm" disabled={!value || !dirty || busy} onClick={() => void save()}>
              {t('environment.compaction.save')}
            </Button>
            {onDirtyChange && (
              <Button size="sm" variant="ghost" disabled={!dirty || busy} onClick={discard}>
                {t('environmentSettings.discard')}
              </Button>
            )}
            {saved && (
              <span role="status" className="text-xs text-primary">
                {t('environment.saved')}
              </span>
            )}
          </div>
        </>
      ) : (
        <>
          {current && (
            <p className="rounded-lg border border-border p-4 text-sm">
              {t('environment.compaction.current', { model: compactionModelLabel(current, options ?? []) })}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {availability === 'stopped'
              ? t('environment.compaction.startToChange')
              : availability === 'not-running'
                ? t('environment.compaction.waitToChange')
                : t('environment.compaction.restart')}
          </p>
        </>
      )}
      {current && (
        <p className="text-xs text-muted-foreground">
          {users.length
            ? t('environment.compaction.usedBy', { bots: formatNames(users, i18n.language) })
            : t('environment.compaction.usedByNone')}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
