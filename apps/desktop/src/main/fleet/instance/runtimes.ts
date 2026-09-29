import type { FleetRuntimeInfo } from '@maestrly/bot-fleet-protocol'
import type { UpdatableRuntimeAssetId } from '../../../shared/runtime-assets'
import { runtimeAssetProgressInfo, runtimeUpdates } from '../../runtime-assets/app-service'

const RUNTIMES: readonly (readonly [UpdatableRuntimeAssetId, FleetRuntimeInfo['id']])[] = [
  ['claude-code-runtime', 'claude-code'],
  ['codex-runtime', 'codex'],
]

/** The environment's Claude Code and Codex, as its bots report them: the version in use and its release channel. */
export async function fleetRuntimeInfo(): Promise<FleetRuntimeInfo[]> {
  return Promise.all(
    RUNTIMES.map(async ([assetId, id]): Promise<FleetRuntimeInfo> => {
      // The progress snapshot never walks the installation, so every status can afford it.
      const info = await runtimeAssetProgressInfo(assetId)
      const image = info.provided?.active ? info.provided : null
      const update = info.update
      return {
        id,
        version: image ? image.version : info.status.state === 'ready' ? (info.status.version ?? null) : null,
        source: image ? 'image' : 'managed',
        automatic: update?.automatic ?? false,
        state: update?.state ?? 'idle',
        availableVersion: update?.availableVersion ?? null,
        lastCheckedAt: update?.lastCheckedAt ?? null,
        error: update?.error ?? null,
      }
    })
  )
}

/** Checks both runtimes now, installing newer releases when automatic updates are on; results arrive in statuses. */
export function checkBotRuntimes(): void {
  void Promise.all(RUNTIMES.map(([assetId]) => runtimeUpdates(assetId).cycle(true))).catch((error: unknown) =>
    console.warn('[bot-runtimes] Runtime check failed', error)
  )
}
