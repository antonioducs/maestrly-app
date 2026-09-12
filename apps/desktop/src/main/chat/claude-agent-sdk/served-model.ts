import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'

export interface ClaudeServedModelMismatch {
  requested: string
  served: string
  message: string
}

function normalized(modelId: string): string {
  const basename = modelId.trim().split('/').pop() ?? modelId.trim()
  return basename.replace(/\[(?:1|2)m\]$/i, '').toLowerCase()
}

function equivalent(requestedModelId: string, servedModelId: string): boolean {
  const requested = normalized(requestedModelId)
  const served = normalized(servedModelId)
  if (requested === served) return true
  return ['fable', 'opus', 'sonnet', 'haiku'].includes(requested) && served.startsWith(`claude-${requested}`)
}

function modelFromResult(result: SDKResultMessage | null): string | null {
  if (!result) return null
  const entries = Object.entries(result.modelUsage ?? {})
  if (entries.length !== 1) return null
  const [key, usage] = entries[0]!
  return typeof usage.canonicalModel === 'string' && usage.canonicalModel ? usage.canonicalModel : key
}

/**
 * Detect downgrades/substitutions without paid probes. The assistant message is the most precise evidence; if
 * absent, modelUsage with exactly one entry is unambiguous. Multiple entries may include subagents.
 */
export function claudeServedModelMismatch(
  requestedModelId: string,
  result: SDKResultMessage | null,
  assistantModelId?: string | null
): ClaudeServedModelMismatch | null {
  if (!requestedModelId || result?.subtype !== 'success') return null
  const served = assistantModelId?.trim() || modelFromResult(result)
  if (!served || equivalent(requestedModelId, served)) return null
  return {
    requested: requestedModelId,
    served,
    message: `Claude served “${served}” instead of the requested model “${requestedModelId}”. The response was retained, but the provider session was discarded to prevent silent model attribution.`,
  }
}
