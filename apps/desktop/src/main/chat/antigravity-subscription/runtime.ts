import path from 'node:path'
import { acquireRuntimeAssetLease, readyRuntimeAsset } from '../../runtime-assets/app-service'
import { hostRuntimeTarget, RUNTIME_ASSET_REGISTRY } from '../../runtime-assets/registry'
import { antigravityLaunchArgs, antigravityServerExecutable } from './paths'

export const ANTIGRAVITY_RUNTIME_ASSET_ID = 'antigravity-acp-runtime' as const
/** Development override: a directory holding an extracted Antigravity ACP server. */
export const ANTIGRAVITY_ACP_DIR_ENV = 'MAESTRLY_ANTIGRAVITY_ACP_DIR'

export interface AntigravityRuntimeCommand {
  command: string
  args: string[]
  release(): void
}

export function antigravityRuntimeOverrideDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[ANTIGRAVITY_ACP_DIR_ENV]?.trim()
  return value ? value : null
}

/**
 * Resolves the ACP server executable. There is no bundled or PATH fallback: outside the development override, only
 * the verified managed runtime asset runs, leased for the lifetime of the process.
 */
export async function resolveAntigravityRuntime(): Promise<AntigravityRuntimeCommand> {
  const override = antigravityRuntimeOverrideDir()
  if (override) {
    return { command: path.join(override, antigravityServerExecutable()), args: antigravityLaunchArgs(), release() {} }
  }
  const asset = await readyRuntimeAsset(ANTIGRAVITY_RUNTIME_ASSET_ID)
  const lease = await acquireRuntimeAssetLease(ANTIGRAVITY_RUNTIME_ASSET_ID, asset.path)
  const target = RUNTIME_ASSET_REGISTRY[ANTIGRAVITY_RUNTIME_ASSET_ID].targets[hostRuntimeTarget()]
  return {
    command: path.join(lease.path, target?.executablePath ?? antigravityServerExecutable()),
    args: antigravityLaunchArgs(),
    release: () => lease.release(),
  }
}
