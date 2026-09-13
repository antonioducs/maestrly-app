import { requestSchema } from '@maestrly/host-protocol'
import { methods, type Call } from '../shared/types'
export function aliasValue(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value))
    throw new Error('Use a single SSH configuration alias (letters, digits, dots, underscores, or hyphens).')
  return value
}
export function validSender(
  expectedId: number,
  senderId: number,
  url: string,
  expectedUrl: string,
  mainFrame: boolean
): boolean {
  return expectedId === senderId && mainFrame && url === expectedUrl
}
export function validateCall(value: unknown): Call {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !['method', 'params'].includes(k))
  )
    throw new Error('Invalid request')
  const call = value as Call
  if (!methods.includes(call.method) || JSON.stringify(value).length > 8192) throw new Error('Invalid request')
  const parsed = requestSchema.parse({ version: 1, id: 'ipc', ...call })
  return { method: parsed.method as Call['method'], params: parsed.params }
}
