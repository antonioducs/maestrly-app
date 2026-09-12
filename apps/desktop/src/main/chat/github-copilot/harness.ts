import type { GitHubCopilotHarnessProfile } from './session-store'

export type GitHubCopilotModelFamily = 'openai' | 'anthropic' | 'generic'

export interface GitHubCopilotHarnessResolution {
  family: GitHubCopilotModelFamily
  profile: GitHubCopilotHarnessProfile
  /** Exact Codex-derived prompt template currently ported by Maestrly. */
  promptProfile: 'maestrly-legacy' | 'maestrly-openai-generic-v1' | 'codex-gpt-5.6-sol@5bed644'
}

function bareModelId(modelId: string): string {
  const normalized = modelId.trim().toLowerCase()
  const slash = normalized.lastIndexOf('/')
  return slash >= 0 ? normalized.slice(slash + 1) : normalized
}

/**
 * Copilot is a transport, not a model family. Resolve the behavioral harness from the selected model on every
 * session contract, so switching GPT <-> Claude never reuses a prompt/session created for the other family.
 */
export function resolveGitHubCopilotHarness(modelId: string): GitHubCopilotHarnessResolution {
  const id = bareModelId(modelId)
  if (/^(?:ft:)?(?:gpt-|chatgpt-|o(?:1|3|4)(?:-|$)|codex(?:-|$))/.test(id)) {
    return {
      family: 'openai',
      profile: 'copilot-openai-v1',
      promptProfile: id === 'gpt-5.6-sol' ? 'codex-gpt-5.6-sol@5bed644' : 'maestrly-openai-generic-v1',
    }
  }
  if (/^(?:claude|fable)(?:[-_.]|$)/.test(id)) {
    return { family: 'anthropic', profile: 'copilot-anthropic-v1', promptProfile: 'maestrly-legacy' }
  }
  return { family: 'generic', profile: 'copilot-generic-v1', promptProfile: 'maestrly-legacy' }
}
