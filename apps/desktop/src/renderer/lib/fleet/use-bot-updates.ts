import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetInstallerStatus } from '../../../shared/fleet-installer'
import { fleetErrorText } from './errors'
import { formatNames } from './environments'
import { botUpdateSummary, type BotUpdateSummary } from './updates'
import type { FleetController } from './use-fleet'
import { useFleetInstaller } from './use-fleet-installer'

/**
 * What bot updates exist and the one click that applies them: the server when this app can update it, then every
 * environment on an older image, each waiting on the server until its bots are idle.
 */
export function useBotUpdates(fleet: FleetController): {
  summary: BotUpdateSummary
  installer: FleetInstallerStatus | null
  run: () => Promise<void>
  starting: boolean
  error: string | null
} {
  const { t, i18n } = useTranslation('fleet')
  const { status: installer } = useFleetInstaller()
  const { connection, snapshot } = fleet.state
  const summary = useMemo(
    () => botUpdateSummary({ installer, connection, snapshot }),
    [installer, connection, snapshot]
  )
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const previousJobId = installer?.job?.id ?? null
  const run = useCallback(async () => {
    setStarting(true)
    setError(null)
    try {
      const result = await window.api.fleetUpdateBots()
      // The installer keeps its last job: only a new one is this click's server update.
      const job = result.status.job && result.status.job.id !== previousJobId ? result.status.job : null
      if (job?.state === 'failed' && job.error) setError(t(`botServer.error.${job.error.code}`))
      else if (result.environments?.failed.length)
        setError(
          t('updates.failed', {
            names: formatNames(
              result.environments.failed.map((item) => item.name),
              i18n.language
            ),
          })
        )
      // Without a server update, a gateway that cannot schedule updates must be updated first.
      else if (!job && result.environments && !result.environments.supported) setError(t('updates.unsupported'))
      await fleet.refresh().catch(() => {})
    } catch (cause) {
      setError(fleetErrorText(cause, t))
    } finally {
      setStarting(false)
    }
  }, [fleet.refresh, previousJobId, t, i18n.language])
  return { summary, installer, run, starting, error }
}
