import { promptMethods, promptRequestSchema, promptResultSchemas, type PromptMethod, type PromptResult } from '@maestrly/host-protocol'
import type { RequestFn } from './bot-client'

export type PromptCall = { method: PromptMethod; params: Record<string, unknown> }

/** Prompt calls are validated by the shared strict schema before anything reaches the wire. */
export function validatePromptCall(value: unknown): PromptCall {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !['method', 'params'].includes(key)))
    throw new Error('Invalid prompt request')
  const call = value as PromptCall
  if (!promptMethods.includes(call.method) || JSON.stringify(value).length > 128 * 1024) throw new Error('Invalid prompt request')
  const parsed = promptRequestSchema.parse({ version: 1, id: 'ipc', ...call })
  return { method: parsed.method as PromptMethod, params: parsed.params as Record<string, unknown> }
}

/**
 * Typed prompt client over the active Host transport. Prompts carry `expectedRevision` on every
 * change and are cheap to repeat, so there is no journal: a lost reply is answered by listing
 * again, never by re-sending blindly.
 */
export class PromptClient {
  private hostId = ''
  constructor(private readonly request: RequestFn) {}
  connected(hostId: string) {
    this.hostId = hostId
  }
  async call<M extends PromptMethod>(input: unknown): Promise<PromptResult<M>> {
    const call = validatePromptCall(input)
    if (!this.hostId) throw new Error('Conecte-se a um computador antes de usar comandos')
    const result = await this.request(call.method, call.params)
    return promptResultSchemas[call.method].parse(result) as PromptResult<M>
  }
}
