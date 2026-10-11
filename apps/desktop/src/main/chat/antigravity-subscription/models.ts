import type { ChatModelMeta } from '../../../shared/chat'
import type { AcpConfigSelectOption } from '../acp/protocol'

export type AntigravityEffort = 'low' | 'medium' | 'high'

/**
 * One Maestrly model backed by one or more ACP `model` options. Antigravity encodes the thinking level in the
 * option itself ("Gemini 3.1 Pro (High)" = `gemini-pro-agent`), so effort variants are grouped under a stable id.
 */
export interface AntigravityModelEntry {
  /** Stable Maestrly id, e.g. `gemini-3.1-pro`. */
  id: string
  displayName: string
  /** Effort -> ACP option value. Empty for options without an effort suffix. */
  efforts: Partial<Record<AntigravityEffort, string>>
  defaultEffort?: AntigravityEffort
}

const EFFORT_ORDER: readonly AntigravityEffort[] = ['low', 'medium', 'high']
const EFFORT_SUFFIX = /^(.*\S)\s*\((High|Medium|Low)\)$/i

export function parseAntigravityModelOptions(options: readonly AcpConfigSelectOption[]): AntigravityModelEntry[] {
  const entries: AntigravityModelEntry[] = []
  const byId = new Map<string, AntigravityModelEntry>()
  for (const option of options) {
    if (!option || typeof option.value !== 'string' || !option.value) continue
    const name = typeof option.name === 'string' && option.name.trim() ? option.name.trim() : option.value
    const match = EFFORT_SUFFIX.exec(name)
    if (!match) {
      if (byId.has(option.value)) continue
      const entry: AntigravityModelEntry = { id: option.value, displayName: name, efforts: {} }
      byId.set(entry.id, entry)
      entries.push(entry)
      continue
    }
    const displayName = match[1]
    const effort = match[2].toLowerCase() as AntigravityEffort
    const id = displayName.toLowerCase().replace(/\s+/g, '-')
    let entry = byId.get(id)
    if (!entry) {
      entry = { id, displayName, efforts: {} }
      byId.set(id, entry)
      entries.push(entry)
    }
    entry.efforts[effort] ??= option.value
  }
  for (const entry of entries) {
    const defaultEffort = (['high', 'medium', 'low'] as const).find((effort) => entry.efforts[effort])
    if (defaultEffort) entry.defaultEffort = defaultEffort
  }
  return entries
}

/** ACP option value for a model and requested effort; unsupported or absent efforts fall back to the default. */
export function resolveAntigravityModelValue(
  entries: readonly AntigravityModelEntry[],
  modelId: string,
  effort?: string
): string | null {
  const entry = entries.find((candidate) => candidate.id === modelId)
  if (!entry) return null
  if (!entry.defaultEffort) return entry.id
  const requested = EFFORT_ORDER.includes(effort as AntigravityEffort) ? (effort as AntigravityEffort) : undefined
  return (requested && entry.efforts[requested]) || entry.efforts[entry.defaultEffort] || null
}

export function antigravityModelEfforts(entry: AntigravityModelEntry): AntigravityEffort[] {
  return EFFORT_ORDER.filter((effort) => entry.efforts[effort])
}

export function antigravityModelMeta(entry: AntigravityModelEntry): ChatModelMeta {
  const efforts = antigravityModelEfforts(entry)
  // Image prompt blocks are native; tool images are described by Maestrly's interpreter instead.
  return { chatCapable: true, vision: true, reasoning: efforts.length > 0, reasoningEfforts: efforts }
}
