import { requestSchema, botMethods, botRequestSchema, BOT_DESKTOP_METHODS, BOT_SECRET_METHODS, type BotMethod } from '@maestrly/host-protocol'
import { methods, type Call, type BotCall } from '../shared/types'
/** Bot calls are validated by the shared strict schema; secret-bearing methods are flagged for journaling. */
export function validateBotCall(value: unknown): { call: BotCall; secret: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((k) => !['method', 'params'].includes(k)))
    throw new Error('Invalid bot request')
  const call = value as BotCall
  if (call.method.startsWith('account.peer.')) throw new Error('Peer account operations are internal to the application')
  // Tickets and control capabilities never reach the renderer: desktop calls go through main only.
  if (BOT_DESKTOP_METHODS.includes(call.method)) throw new Error('Desktop operations are handled by the application')
  if (!botMethods.includes(call.method) || JSON.stringify(value).length > 128 * 1024) throw new Error('Invalid bot request')
  const parsed = botRequestSchema.parse({ version: 1, id: 'ipc', ...call })
  return { call: { method: parsed.method as BotMethod, params: parsed.params as Record<string, unknown> }, secret: BOT_SECRET_METHODS.includes(parsed.method) }
}
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
