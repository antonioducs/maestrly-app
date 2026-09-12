import { subscriptionBaseProviderId } from '../../shared/chat'

/** Conservative execution-family derivation. Unknown endpoints never count as independent. */
export function deriveExecutionFamily(providerId: string, modelId: string): string {
  const provider = subscriptionBaseProviderId(providerId).toLowerCase()
  const model = modelId.toLowerCase()
  const value = `${provider} ${model}`
  if (/openai|chatgpt|codex|\bgpt[-_]/.test(value)) return 'openai'
  if (/anthropic|claude/.test(value)) return 'anthropic'
  if (/google|gemini|gemma/.test(value)) return 'google'
  if (/xai|grok/.test(value)) return 'xai'
  if (/deepseek/.test(value)) return 'deepseek'
  if (/moonshot|kimi/.test(value)) return 'moonshot'
  if (/alibaba|qwen/.test(value)) return 'alibaba'
  if (/mistral|codestral/.test(value)) return 'mistral'
  if (/meta|llama/.test(value)) return 'meta'
  return 'unknown'
}

export function familiesAreIndependent(left: string, right: string): boolean {
  return left !== 'unknown' && right !== 'unknown' && left !== right
}
