import { resolveHarness } from '../resolver'
import type { HarnessRegistry, ResolvedHarness } from '../types'

export type GitHubCopilotModelFamily = 'openai' | 'anthropic' | 'generic'
export type GitHubCopilotHarnessProfile = 'copilot-openai-v1' | 'copilot-anthropic-v1' | 'copilot-generic-v1'

export interface GitHubCopilotHarnessResolution {
  family: GitHubCopilotModelFamily
  profile: GitHubCopilotHarnessProfile
  /** Exact prompt template identity currently ported by Maestrly for this model. */
  promptProfile: string
  /** Prompt-axis-only contract: text and layout, never capabilities or behavioral policy. */
  harness: ResolvedHarness
}

/**
 * Legacy Copilot normalization, deliberately scoped to this transport: Copilot publishes gateway
 * prefixes that the session contract already depends on. It selects the textual/session axis only
 * and is never treated as canonical evidence for advanced policies.
 */
function bareModelId(modelId: string): string {
  const normalized = modelId.trim().toLowerCase()
  const slash = normalized.lastIndexOf('/')
  return slash >= 0 ? normalized.slice(slash + 1) : normalized
}

function familyOf(id: string): { family: GitHubCopilotModelFamily; profile: GitHubCopilotHarnessProfile; fallbackPrompt: string } {
  if (/^(?:ft:)?(?:gpt-|chatgpt-|o(?:1|3|4)(?:-|$)|codex(?:-|$))/.test(id)) {
    return { family: 'openai', profile: 'copilot-openai-v1', fallbackPrompt: 'maestrly-openai-generic-v1' }
  }
  if (/^(?:claude|fable)(?:[-_.]|$)/.test(id)) {
    return { family: 'anthropic', profile: 'copilot-anthropic-v1', fallbackPrompt: 'maestrly-legacy' }
  }
  return { family: 'generic', profile: 'copilot-generic-v1', fallbackPrompt: 'maestrly-legacy' }
}

/**
 * Copilot is a transport, not a model family. The behavioral harness is resolved from the selected
 * model on every session contract, so switching GPT <-> Claude never reuses a prompt or session
 * created for the other family.
 */
export function resolveGitHubCopilotHarness(modelId: string, registry: HarnessRegistry): GitHubCopilotHarnessResolution {
  const id = bareModelId(modelId)
  const { family, profile, fallbackPrompt } = familyOf(id)
  const resolution = resolveHarness(
    {
      providerKind: 'github-copilot-subscription',
      requestedModelId: id,
      promptAxisOnly: true,
    },
    registry
  )
  if (!resolution.ok) throw new Error(`unexpected Copilot harness resolution failure: ${resolution.reason}`)
  const specific =
    resolution.harness.reason === 'matched-requested-model' || resolution.harness.reason === 'matched-alias'
  return {
    family,
    profile,
    promptProfile: specific ? resolution.harness.identity.promptIdentity : fallbackPrompt,
    harness: resolution.harness,
  }
}
