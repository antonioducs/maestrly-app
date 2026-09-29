import { FLEET_ENVIRONMENT_UPDATES_FEATURE } from '@maestrly/bot-fleet-protocol'
import type { FleetEnvironmentUpdateResult } from '../../../shared/fleet-installer'
import { InstallerError } from './errors'
import type { FleetInstallerFleet } from './service'

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new InstallerError('cancelled'))
    const onAbort = () => {
      clearTimeout(timer)
      reject(new InstallerError('cancelled'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Schedules the update of every running environment whose container runs an older image than the server offers and
 * none waits for yet. Each waits on the gateway until its bots are idle, so this answers at once. After a server
 * update the fleet client reconnects on its own, and its features come from the new gateway: this waits up to
 * `waitMs` for a connected gateway that schedules updates. Each environment fails on its own.
 */
export async function scheduleEnvironmentUpdates(
  fleet: Pick<FleetInstallerFleet, 'getConnection' | 'hasFeature' | 'call'>,
  options: { signal?: AbortSignal; waitMs?: number; pollMs?: number } = {}
): Promise<FleetEnvironmentUpdateResult> {
  const deadline = Date.now() + (options.waitMs ?? 120_000)
  while (!(fleet.getConnection().state === 'connected' && fleet.hasFeature(FLEET_ENVIRONMENT_UPDATES_FEATURE))) {
    if (options.signal?.aborted) throw new InstallerError('cancelled')
    if (Date.now() >= deadline) return { supported: false, scheduled: [], failed: [] }
    await sleep(options.pollMs ?? 500, options.signal)
  }
  const { environments } = await fleet.call('environmentsList')
  const result: FleetEnvironmentUpdateResult = { supported: true, scheduled: [], failed: [] }
  for (const environment of environments) {
    if (environment.lifecycle !== 'running' || !environment.update?.available || environment.update.pendingSince)
      continue
    try {
      await fleet.call('environmentUpdate', { params: { eid: environment.id }, body: { when: 'idle' } })
      result.scheduled.push(environment.id)
    } catch (error) {
      result.failed.push({
        environmentId: environment.id,
        name: environment.name,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return result
}
