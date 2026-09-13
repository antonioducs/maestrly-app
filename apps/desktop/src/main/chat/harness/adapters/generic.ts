import type { ChatProviderKind } from '../../../../shared/chat'
import type { HarnessCapabilityClaims } from '../../../../shared/harness'
import { codexAdapterCapabilities, type CodexRuntimeFacts } from './codex'
import { responsesAdapterCapabilities } from './responses'

/**
 * What each transport actually implements today. Configuration can restrict these facts but never
 * invent an implementation: an explicit `false` here always wins over a permissive profile.
 */
export function adapterCapabilitiesFor(
  kind: ChatProviderKind,
  facts?: CodexRuntimeFacts
): HarnessCapabilityClaims {
  if (kind === 'openai-responses') return responsesAdapterCapabilities()
  if (kind === 'codex-subscription' && facts) return codexAdapterCapabilities(facts)
  return {}
}
