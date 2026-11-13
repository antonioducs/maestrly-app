// Between the canvas and the host: what the person changes goes out in batches, at most one request at a time, and what
// others change comes in without being sent back. No React and no Excalidraw here, so it is tested on its own.

/** The elements a canvas sends at once as JSON, as the viewer shell accepts them. */
export const MAX_BOARD_PUSH_BYTES = 900 * 1024
const MAX_BOARD_PUSH_ELEMENTS = 1000
const LONGEST_RETRY_MS = 10_000

export type SyncElement = { id: string; version: number } & Record<string, unknown>

export interface SyncDeps {
  push(elements: readonly SyncElement[]): Promise<{ revision: number; kept: readonly SyncElement[] }>
  /** Shows elements from the host on the canvas. */
  apply(elements: readonly SyncElement[]): void
  /** The host no longer takes this person's changes. */
  onReadOnly(): void
  intervalMs?: number
  maxBatch?: number
  maxBytes?: number
}

export interface Sync {
  /** The canvas's elements after a change; only those newer than the host's copy are sent. */
  local(elements: readonly SyncElement[]): void
  /** Elements from the host: the board when it opens, others' changes, and copies the host kept. */
  remote(elements: readonly SyncElement[]): void
  /** Sends what is waiting now, and resolves once it is sent or could not be. */
  flush(): Promise<void>
}

const encoder = new TextEncoder()
const codeOf = (error: unknown): string | undefined => (error as { code?: unknown })?.code as string | undefined

export function createSync(deps: SyncDeps): Sync {
  const intervalMs = deps.intervalMs ?? 400
  const maxBatch = deps.maxBatch ?? MAX_BOARD_PUSH_ELEMENTS
  const maxBytes = deps.maxBytes ?? MAX_BOARD_PUSH_BYTES
  /** The newest version of each element the host has, or will have once what is waiting is sent. */
  const known = new Map<string, number>()
  const waiting = new Map<string, SyncElement>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let sending: Promise<void> | null = null
  let failures = 0
  let readOnly = false

  function schedule(): void {
    if (timer || sending || readOnly || !waiting.size) return
    const delay = failures ? Math.min(LONGEST_RETRY_MS, intervalMs * 2 ** failures) : intervalMs
    timer = setTimeout(() => {
      timer = null
      void send()
    }, delay)
  }

  /** Batches within the shell's limits, in the order the elements changed. */
  function batches(elements: readonly SyncElement[]): SyncElement[][] {
    const result: SyncElement[][] = []
    let batch: SyncElement[] = []
    let bytes = 2
    for (const element of elements) {
      const size = encoder.encode(JSON.stringify(element)).byteLength + 1
      if (batch.length && (batch.length >= maxBatch || bytes + size > maxBytes)) {
        result.push(batch)
        batch = []
        bytes = 2
      }
      batch.push(element)
      bytes += size
    }
    if (batch.length) result.push(batch)
    return result
  }

  /** Puts back what did not reach the host, unless a newer copy is already waiting. */
  function requeue(elements: readonly SyncElement[]): void {
    for (const element of elements) {
      const newer = waiting.get(element.id)
      if (!newer || newer.version < element.version) waiting.set(element.id, element)
    }
  }

  async function run(): Promise<void> {
    while (waiting.size && !readOnly) {
      const parts = batches([...waiting.values()])
      waiting.clear()
      for (const [index, batch] of parts.entries()) {
        try {
          const result = await deps.push(batch)
          failures = 0
          if (result.kept.length) remote(result.kept)
        } catch (error) {
          if (codeOf(error) === 'read_only') {
            readOnly = true
            waiting.clear()
            deps.onReadOnly()
            return
          }
          failures++
          for (const rest of parts.slice(index)) requeue(rest)
          return
        }
      }
    }
  }

  function send(): Promise<void> {
    if (sending) return sending
    sending = run().finally(() => {
      sending = null
      schedule()
    })
    return sending
  }

  function remote(elements: readonly SyncElement[]): void {
    for (const element of elements) {
      if (element.version >= (known.get(element.id) ?? 0)) known.set(element.id, element.version)
      const queued = waiting.get(element.id)
      if (queued && queued.version <= element.version) waiting.delete(element.id)
    }
    deps.apply(elements)
  }

  return {
    local(elements) {
      if (readOnly) return
      for (const element of elements) {
        if (element.version <= (known.get(element.id) ?? 0)) continue
        known.set(element.id, element.version)
        waiting.set(element.id, element)
      }
      schedule()
    },
    remote,
    async flush() {
      if (timer) clearTimeout(timer)
      timer = null
      if (sending) await sending
      await send()
    },
  }
}
