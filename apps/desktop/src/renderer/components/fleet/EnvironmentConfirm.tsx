import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FleetEnvironment } from '@maestrly/bot-fleet-protocol'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { environmentBots, formatNames } from '@/lib/fleet/environments'
import { fleetErrorText } from '@/lib/fleet/errors'
import { updateBlockers } from '@/lib/fleet/updates'
import type { FleetController } from '@/lib/fleet/use-fleet'

/** `update` restarts on a gateway that cannot schedule updates; `updateNow` forces a scheduled one. */
export type EnvironmentConfirmKind = 'restart' | 'update' | 'updateNow' | 'stop' | 'archive'

/**
 * Asks before an action that acts on every bot of an environment, naming them, and runs it. It stays open with the
 * reason when the action fails.
 */
export function EnvironmentConfirm({
  kind,
  environment,
  fleet,
  onCancel,
  onDone,
}: {
  kind: EnvironmentConfirmKind
  environment: FleetEnvironment
  fleet: FleetController
  onCancel: () => void
  onDone: (kind: EnvironmentConfirmKind) => void
}) {
  const { t, i18n } = useTranslation('fleet')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const bots = environmentBots(environment, fleet.state.snapshot.bots)
  const blockers = updateBlockers(environment, fleet.state.snapshot.bots)
  const names =
    formatNames(
      bots.map((bot) => bot.name),
      i18n.language
    ) || t('environment.noBotsNamed')
  const blockerNames = formatNames(
    blockers.map((bot) => bot.name),
    i18n.language
  )
  // Stable: the dialog refocuses on a new callback, and the view re-renders with every resource sample.
  const cancel = useCallback(() => {
    if (!busy) onCancel()
  }, [busy, onCancel])
  async function run() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      // On a gateway that cannot schedule updates, updating is a restart: the environment comes back on the image the
      // server offers. Updating now does the same through the update route, which also drops a waiting update.
      const updated =
        kind === 'updateNow'
          ? await window.api.fleetEnvironmentUpdate(environment.id, 'now')
          : await window.api.fleetEnvironmentAction(environment.id, kind === 'update' ? 'restart' : kind)
      fleet.dispatch({
        type: 'event',
        value: { type: 'environment.updated', at: new Date().toISOString(), environment: updated },
      })
      onDone(kind)
    } catch (cause) {
      setError(fleetErrorText(cause, t))
    } finally {
      setBusy(false)
    }
  }
  const title =
    kind === 'restart'
      ? t('environment.confirmRestartTitle', { name: environment.name })
      : kind === 'update'
        ? t('environment.confirmUpdateTitle', { name: environment.name })
        : kind === 'updateNow'
          ? t('updates.confirmNowTitle', { name: environment.name })
          : kind === 'stop'
            ? t('environment.confirmStopTitle', { name: environment.name })
            : t('environment.confirmArchiveTitle')
  const message =
    kind === 'restart'
      ? t('environment.confirmRestart', { bots: names })
      : kind === 'update'
        ? t('environment.confirmUpdate', { bots: names })
        : kind === 'updateNow'
          ? blockers.length
            ? t('updates.confirmNow', { bots: blockerNames, count: blockers.length })
            : t('updates.confirmNowIdle', { bots: names })
          : kind === 'stop'
            ? t('environment.confirmStop', { bots: names })
            : t('environment.confirmArchive', { bots: names })
  const confirmLabel =
    kind === 'restart'
      ? t('environment.restartButton')
      : kind === 'update'
        ? t('environment.updateButton')
        : kind === 'updateNow'
          ? t('updates.updateNow')
          : kind === 'stop'
            ? t('environment.stopButton')
            : t('environment.archiveButton')
  return (
    <ConfirmDialog
      title={title}
      message={message}
      confirmLabel={confirmLabel}
      destructive={kind === 'archive' || kind === 'stop' || (kind === 'updateNow' && blockers.length > 0)}
      busy={busy}
      error={error || null}
      onCancel={cancel}
      onConfirm={() => void run()}
    />
  )
}
