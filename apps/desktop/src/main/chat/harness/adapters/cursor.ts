import { NO_HARNESS_CAPABILITIES, type HarnessCapabilityClaims } from '../../../../shared/harness'
import { resolveHarness } from '../resolver'
import { harnessRegistry } from '../catalog'
import { captureHarnessFlags } from '../flags'
import type { ResolveChatHarnessOptions } from '../execution'
import type { ResolvedHarness } from '../types'

/** The SDK retains its native prompt. Host instructions are additive context, not a prompt replacement. */
export function cursorAdapterCapabilities(): HarnessCapabilityClaims {
  // Portable host summarization is not native provider compaction or persisted reasoning.
  return { ...NO_HARNESS_CAPABILITIES }
}

export function resolveCursorHarness(modelId: string, options: ResolveChatHarnessOptions = {}): ResolvedHarness {
  const result = resolveHarness(
    {
      ...options,
      providerKind: 'cursor-subscription',
      requestedModelId: modelId,
      flags: options.flags ?? captureHarnessFlags(),
      adapterCapabilities: cursorAdapterCapabilities(),
    },
    harnessRegistry()
  )
  if (!result.ok) throw new Error(result.reason)
  return result.harness
}
