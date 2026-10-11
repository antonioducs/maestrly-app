import { NO_HARNESS_CAPABILITIES, type HarnessCapabilityClaims } from '../../../../shared/harness'
import { resolveHarness } from '../resolver'
import { harnessRegistry } from '../catalog'
import { captureHarnessFlags } from '../flags'
import type { ResolveChatHarnessOptions } from '../execution'
import type { ResolvedHarness } from '../types'

/**
 * The Antigravity ACP server keeps its own agent prompt; Maestrly's instructions travel in the first user prompt.
 * It exposes no native compaction, persisted reasoning, steering, or configuration updates.
 */
export function antigravityAdapterCapabilities(): HarnessCapabilityClaims {
  return { ...NO_HARNESS_CAPABILITIES }
}

export function resolveAntigravityHarness(modelId: string, options: ResolveChatHarnessOptions = {}): ResolvedHarness {
  const result = resolveHarness(
    {
      ...options,
      providerKind: 'antigravity-subscription',
      requestedModelId: modelId,
      flags: options.flags ?? captureHarnessFlags(),
      adapterCapabilities: antigravityAdapterCapabilities(),
    },
    harnessRegistry()
  )
  if (!result.ok) throw new Error(result.reason)
  return result.harness
}
