import type { FleetInstanceStatus, FleetRuntimeInfo } from '@maestrly/bot-fleet-protocol'
import type { UpdatableRuntimeAssetId } from '../../../shared/runtime-assets'
import { botClaudeRuntime } from '../../chat/claude-agent-sdk/runtime-selection'
import { listCodexSubscriptionManagers } from '../../chat/codex-subscription/manager'
import { listAntigravitySubscriptionManagers } from '../../chat/antigravity-subscription/manager'
import { runtimeAssetProgressInfo, runtimeUpdates } from '../../runtime-assets/app-service'

const RUNTIMES: readonly (readonly [UpdatableRuntimeAssetId, FleetRuntimeInfo['id']])[] = [
  ['claude-code-runtime', 'claude-code'],
  ['codex-runtime', 'codex'],
  ['antigravity-acp-runtime', 'antigravity-acp'],
]

type RuntimeVersion = Pick<FleetRuntimeInfo, 'version' | 'source'>

/**
 * The versions the bots run now. Work in progress keeps the one it started with after another is selected: a Claude
 * Code query until it ends, a Codex connection until no bot is working. Nothing listed means the next use starts the
 * selected version.
 */
function runtimesInUse(id: FleetRuntimeInfo['id']): RuntimeVersion[] {
  if (id === 'claude-code') return botClaudeRuntime().inUse()
  if (id === 'antigravity-acp') {
    return listAntigravitySubscriptionManagers().flatMap((manager): RuntimeVersion[] => {
      const runtime = manager.connectedRuntime
      return runtime?.source === 'managed' ? [{ version: runtime.version ?? null, source: 'managed' }] : []
    })
  }
  return listCodexSubscriptionManagers().flatMap((manager): RuntimeVersion[] => {
    const runtime = manager.connectedRuntime
    return runtime ? [{ version: runtime.version, source: runtime.source === 'managed' ? 'managed' : 'image' }] : []
  })
}

/**
 * The environment's managed runtimes, as its bots report them: the version they run, the one they switch to once
 * their work in progress ends, and the release channel.
 */
export async function fleetRuntimeInfo(): Promise<FleetRuntimeInfo[]> {
  return Promise.all(
    RUNTIMES.map(async ([assetId, id]): Promise<FleetRuntimeInfo> => {
      // The progress snapshot never walks the installation, so every status can afford it.
      const info = await runtimeAssetProgressInfo(assetId)
      const image = info.provided?.active ? info.provided : null
      const update = info.update
      const selected: RuntimeVersion = {
        version: image ? image.version : info.status.state === 'ready' ? (info.status.version ?? null) : null,
        source: image ? 'image' : 'managed',
      }
      // A runtime without a known version (a development PATH install) is never reported as a pending switch.
      const behind = selected.version
        ? runtimesInUse(id).find((runtime) => runtime.version && runtime.version !== selected.version)
        : undefined
      return {
        id,
        version: behind?.version ?? selected.version,
        source: behind?.source ?? selected.source,
        pendingVersion: behind ? selected.version : null,
        automatic: update?.automatic ?? false,
        state: update?.state ?? 'idle',
        availableVersion: update?.availableVersion ?? null,
        lastCheckedAt: update?.lastCheckedAt ?? null,
        error: update?.error ?? null,
      }
    })
  )
}

/** Checks installed runtimes now, installing newer releases when automatic updates are on. */
export function checkBotRuntimes(): void {
  void Promise.all(RUNTIMES.map(([assetId]) => runtimeUpdates(assetId).cycle(true))).catch((error: unknown) =>
    console.warn('[bot-runtimes] Runtime check failed', error)
  )
}

/** Keep new runtime IDs out of the array validated by older gateways and desktops. */
export async function fleetRuntimeReport(): Promise<Pick<FleetInstanceStatus, 'runtimes' | 'additionalRuntimes'>> {
  const runtimes = await fleetRuntimeInfo().catch(() => null)
  if (!runtimes) return { runtimes: null }
  return {
    runtimes: runtimes.filter((runtime) => runtime.id === 'claude-code' || runtime.id === 'codex'),
    additionalRuntimes: runtimes.filter((runtime) => runtime.id !== 'claude-code' && runtime.id !== 'codex'),
  }
}
