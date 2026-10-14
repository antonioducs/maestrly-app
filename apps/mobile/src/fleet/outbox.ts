import { z } from 'zod'
import { GatewayError } from '../gateway/client'
import type { OutboxAttachment } from './attachments'

export type OutboxErrorKey =
  | 'server'
  | 'botStopped'
  | 'filesUnsupported'
  | 'invalid'
  | 'botGone'
  | 'conflict'
  | 'missingFile'
  | 'generic'

/** A message written on the phone that the server has not confirmed yet. Its id is the request's idempotency key. */
export type OutboxEntry = {
  id: string
  serverId: string
  botId: string
  text: string
  attachments: OutboxAttachment[]
  createdAt: string
  state: 'waiting' | 'sending' | 'failed'
  error: OutboxErrorKey | null
  attempts: number
}

export const outboxEntriesSchema = z.array(
  z.object({
    id: z.string().min(1),
    serverId: z.string(),
    botId: z.string(),
    text: z.string(),
    attachments: z.array(
      z.object({
        name: z.string(),
        kind: z.enum(['image', 'pdf', 'text']),
        mediaType: z.string(),
        uri: z.string(),
        byteSize: z.number(),
      })
    ),
    createdAt: z.string(),
    state: z.enum(['waiting', 'sending', 'failed']),
    error: z
      .enum(['server', 'botStopped', 'filesUnsupported', 'invalid', 'botGone', 'conflict', 'missingFile', 'generic'])
      .nullable(),
    attempts: z.number(),
  })
)

export class MissingFileError extends Error {
  constructor(name: string) {
    super(`The attached file ${name} is gone`)
    this.name = 'MissingFileError'
  }
}

/** A server error that may pass is retried this many times before the message is shown as not sent. */
const SERVER_ATTEMPTS = 3

/** One message per bot at a time, its oldest waiting one, so a bot receives messages in the order they were written. */
export function nextToSend(entries: OutboxEntry[], serverId: string): OutboxEntry[] {
  const mine = entries.filter((entry) => entry.serverId === serverId)
  const busy = new Set(mine.filter((entry) => entry.state === 'sending').map((entry) => entry.botId))
  const next = new Map<string, OutboxEntry>()
  for (const entry of [...mine].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (entry.state !== 'waiting' || busy.has(entry.botId) || next.has(entry.botId)) continue
    next.set(entry.botId, entry)
  }
  return [...next.values()]
}

const failed = (entry: OutboxEntry, error: OutboxErrorKey): OutboxEntry => ({ ...entry, state: 'failed', error })

/** What a message becomes after a failed send: back in line when the failure may pass, or not sent with a reason. */
export function afterSendFailure(entry: OutboxEntry, error: unknown): OutboxEntry {
  if (error instanceof MissingFileError) return failed(entry, 'missingFile')
  if (error instanceof Error && error.name === 'ZodError') return failed(entry, 'invalid')
  if (!(error instanceof GatewayError)) return failed(entry, 'generic')
  const attempts = entry.attempts + 1
  if (error.code === 'NETWORK' || error.code === 'TIMEOUT' || error.code === 'UNAUTHORIZED')
    return { ...entry, state: 'waiting', error: null, attempts }
  if (error.status === 413 || error.code === 'INVALID_REQUEST') return failed(entry, 'invalid')
  if (error.code === 'BOT_NOT_RUNNING') return failed(entry, 'botStopped')
  if (error.code === 'PROTOCOL_INCOMPATIBLE') return failed(entry, 'filesUnsupported')
  if (error.code === 'NOT_FOUND') return failed(entry, 'botGone')
  if (error.code === 'CONFLICT') return failed(entry, 'conflict')
  if (error.status >= 500)
    return attempts >= SERVER_ATTEMPTS
      ? { ...failed(entry, 'server'), attempts }
      : { ...entry, state: 'waiting', error: null, attempts }
  return failed(entry, 'generic')
}
