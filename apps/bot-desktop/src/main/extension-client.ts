import { extensionMethods, extensionRequestSchema, extensionResultSchemas, type ExtensionMethod, type ExtensionResult } from '@maestrly/host-protocol'
import type { RequestFn } from './bot-client'

export type ExtensionCall = { method: ExtensionMethod; params: Record<string, unknown> }

/** Extension calls are validated by the shared strict schema before anything reaches the wire. */
export function validateExtensionCall(value: unknown): ExtensionCall {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !['method', 'params'].includes(key)))
    throw new Error('Invalid extension request')
  const call = value as ExtensionCall
  // A skill travels as base64 files; the schema bounds each one, this bounds the whole frame.
  if (!extensionMethods.includes(call.method) || JSON.stringify(value).length > 2 * 1024 * 1024) throw new Error('Invalid extension request')
  const parsed = extensionRequestSchema.parse({ version: 1, id: 'ipc', ...call })
  return { method: parsed.method as ExtensionMethod, params: parsed.params as Record<string, unknown> }
}

/**
 * Typed extension client over the active Host transport. Every change carries `expectedRevision`
 * and the Host answers with the whole state, so there is no journal: a lost reply is answered by
 * inspecting again, never by re-sending blindly. Secret values go out inside `env` and never
 * come back — the reply schema has no place for them.
 */
export class ExtensionClient {
  private hostId = ''
  constructor(private readonly request: RequestFn) {}
  connected(hostId: string) {
    this.hostId = hostId
  }
  async call<M extends ExtensionMethod>(input: unknown): Promise<ExtensionResult<M>> {
    const call = validateExtensionCall(input)
    if (!this.hostId) throw new Error('Conecte-se a um computador antes de configurar extensões')
    const result = await this.request(call.method, call.params)
    return extensionResultSchemas[call.method].parse(result) as ExtensionResult<M>
  }
}

/** The description a skill declares in the frontmatter of its SKILL.md; the same rule the Host applies. */
export function skillDescriptionOf(skillMd: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd)
  if (!match) return undefined
  const line = match[1].split(/\r?\n/).find((entry) => /^description\s*:/.test(entry))
  return line ? line.replace(/^description\s*:\s*/, '').replace(/^["']|["']$/g, '').trim() : undefined
}

/** A folder name becomes a skill name: lowercase, dashes, nothing else. */
export function skillNameFrom(folder: string): string {
  return folder
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}
