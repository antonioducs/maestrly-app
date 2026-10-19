/**
 * How many subagents a group of conversations runs at once: a bot's conversations share one pool, so its routine runs
 * and its conversation with the owner never start more tasks together than the owner allows. Unregistered
 * conversations are not limited.
 */
interface Pool {
  limit: number
  active: number
  waiters: Array<() => void>
}

export const SUBAGENT_SLOT_WAIT_LINE = 'Waiting for a free task slot'

const conversations = new Map<string, { pool: string; limit: number }>()
const pools = new Map<string, Pool>()

function drain(pool: Pool): void {
  while (pool.active < pool.limit && pool.waiters.length) {
    pool.active += 1
    pool.waiters.shift()!()
  }
}

export function setSubagentConcurrency(conversationId: string, value: { pool: string; limit: number } | null): void {
  if (!value) {
    conversations.delete(conversationId)
    return
  }
  conversations.set(conversationId, value)
  const pool = pools.get(value.pool)
  if (pool) {
    pool.limit = value.limit
    drain(pool)
  }
}

export function subagentConcurrencyOf(conversationId: string): { pool: string; limit: number } | null {
  return conversations.get(conversationId) ?? null
}

/** Waits for a free slot of the conversation's pool; the returned function gives it back (once). */
export async function acquireSubagentSlot(
  conversationId: string,
  signal: AbortSignal,
  onWait?: () => void
): Promise<() => void> {
  const entry = conversations.get(conversationId)
  if (!entry) return () => {}
  signal.throwIfAborted()
  let pool = pools.get(entry.pool)
  if (!pool) {
    pool = { limit: entry.limit, active: 0, waiters: [] }
    pools.set(entry.pool, pool)
  }
  const owned = pool
  if (owned.active < owned.limit) owned.active += 1
  else {
    onWait?.()
    await new Promise<void>((resolve, reject) => {
      const grant = (): void => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = (): void => {
        const index = owned.waiters.indexOf(grant)
        if (index >= 0) owned.waiters.splice(index, 1)
        reject(signal.reason ?? new Error('Subagent wait aborted'))
      }
      owned.waiters.push(grant)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
  let released = false
  return () => {
    if (released) return
    released = true
    owned.active = Math.max(0, owned.active - 1)
    drain(owned)
  }
}
