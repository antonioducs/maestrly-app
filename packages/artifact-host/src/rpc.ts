import type { ArtifactAdmin } from './admin.js'
import { ArtifactHostError, type SerializedArtifactError } from './errors.js'

/** A message channel between processes, such as an Electron utility process and its parent. */
export interface RpcChannel {
  post(message: unknown): void
  onMessage(listener: (message: unknown) => void): () => void
}

export const ADMIN_METHODS = [
  'status',
  'create',
  'update',
  'get',
  'list',
  'listFiles',
  'readFile',
  'delete',
  'setThumbnail',
  'getThumbnail',
  'mintOwnerTicket',
  'snapshot',
  'getSharing',
  'setSharing',
  'createInvite',
  'resetInvite',
  'revokePerson',
  'revokeDevice',
  'revokeAllSessions',
  'decideAccessRequest',
  'listEvents',
  'markEventsSeen',
  'listComments',
  'addComment',
  'setCommentResolved',
  'deleteComment',
] as const satisfies readonly (keyof ArtifactAdmin)[]

export type AdminMethod = (typeof ADMIN_METHODS)[number]

interface CallMessage {
  type: 'call'
  id: number
  method: AdminMethod
  args: unknown[]
}

type ResultBody = { ok: true; value: unknown } | { ok: false; error: SerializedArtifactError }
type ResultMessage = { type: 'result'; id: number } & ResultBody

const MAX_ARGS = 3
const DEFAULT_TIMEOUT_MS = 60_000

const unavailable = (message: string) => new ArtifactHostError('host_unavailable', message)

export function serializeAdminError(error: unknown): SerializedArtifactError {
  if (error instanceof ArtifactHostError) return error.toJSON()
  // Error messages can contain request URLs or bodies; never log their contents.
  console.error('[artifact-host] admin call failed')
  return { code: 'internal', message: 'Internal artifact host error' }
}

/** Answers admin calls arriving on the channel. Returns a function that stops listening. */
export function serveAdmin(channel: RpcChannel, admin: ArtifactAdmin): () => void {
  return channel.onMessage((message) => {
    const call = message as Partial<CallMessage> | null
    if (call?.type !== 'call' || typeof call.id !== 'number') return
    const id = call.id
    const reply = (result: ResultBody) => channel.post({ type: 'result', id, ...result })
    const method = call.method
    if (
      typeof method !== 'string' ||
      !(ADMIN_METHODS as readonly string[]).includes(method) ||
      !Array.isArray(call.args) ||
      call.args.length > MAX_ARGS
    ) {
      reply({ ok: false, error: new ArtifactHostError('invalid_input', 'Unknown admin call').toJSON() })
      return
    }
    const fn = admin[method] as (...args: unknown[]) => Promise<unknown>
    const args = call.args
    Promise.resolve()
      .then(() => fn(...args))
      .then(
        (value) => reply({ ok: true, value }),
        (error: unknown) => reply({ ok: false, error: serializeAdminError(error) })
      )
  })
}

/** An `ArtifactAdmin` whose calls travel over the channel. Pending calls fail with `host_unavailable`. */
export function createAdminClient(
  channel: RpcChannel,
  options: { timeoutMs?: number } = {}
): ArtifactAdmin & { dispose(): void } {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >()
  let sequence = 0
  let disposed = false

  const stop = channel.onMessage((message) => {
    const result = message as Partial<ResultMessage> | null
    if (result?.type !== 'result' || typeof result.id !== 'number') return
    const call = pending.get(result.id)
    if (!call) return
    pending.delete(result.id)
    clearTimeout(call.timer)
    if (result.ok) call.resolve(result.value)
    else call.reject(ArtifactHostError.from((result as { error?: unknown }).error))
  })

  const call = (method: AdminMethod, args: unknown[]): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (disposed) return reject(unavailable('The artifact host is not running'))
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(unavailable('The artifact host did not answer'))
      }, timeoutMs)
      timer.unref?.()
      pending.set(id, { resolve, reject, timer })
      try {
        channel.post({ type: 'call', id, method, args } satisfies CallMessage)
      } catch {
        pending.delete(id)
        clearTimeout(timer)
        reject(unavailable('The artifact host is not running'))
      }
    })

  const client = Object.fromEntries(
    ADMIN_METHODS.map((method) => [method, (...args: unknown[]) => call(method, args)])
  ) as unknown as ArtifactAdmin

  return Object.assign(client, {
    dispose() {
      if (disposed) return
      disposed = true
      stop()
      for (const { reject, timer } of pending.values()) {
        clearTimeout(timer)
        reject(unavailable('The artifact host stopped'))
      }
      pending.clear()
    },
  })
}
