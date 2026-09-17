import { usageMethods, usageRequestSchema, usageResultSchemas, type UsageMethod, type UsageResult } from '@maestrly/host-protocol'
import type { RequestFn } from './bot-client'

export type UsageCall = { method: UsageMethod; params: Record<string, unknown> }

/** Usage calls are validated by the shared strict schema before anything reaches the wire. */
export function validateUsageCall(value: unknown): UsageCall {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !['method', 'params'].includes(key)))
    throw new Error('Invalid usage request')
  const call = value as UsageCall
  if (!usageMethods.includes(call.method) || JSON.stringify(value).length > 4096) throw new Error('Invalid usage request')
  const parsed = usageRequestSchema.parse({ version: 1, id: 'ipc', ...call })
  return { method: parsed.method as UsageMethod, params: parsed.params as Record<string, unknown> }
}

/** Read-only summaries over the Host's ledger: nothing to journal, the reply is validated and handed over. */
export class UsageClient {
  private hostId = ''
  constructor(private readonly request: RequestFn) {}
  connected(hostId: string) {
    this.hostId = hostId
  }
  async call<M extends UsageMethod>(input: unknown): Promise<UsageResult<M>> {
    const call = validateUsageCall(input)
    if (!this.hostId) throw new Error('Conecte-se a um computador antes de ver o uso')
    const result = await this.request(call.method, call.params)
    return usageResultSchemas[call.method].parse(result) as UsageResult<M>
  }
}
