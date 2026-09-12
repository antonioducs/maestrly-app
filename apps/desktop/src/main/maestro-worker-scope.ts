export type MaestroWorkerCleanup = () => void | Promise<void>

export interface MaestroWorkerScope {
  /** Operational identity. This is the delegation/tool-call id, never an agent display name. */
  readonly id: string
  readonly conversationId: string
  readonly label: string
  readonly signal?: AbortSignal
  runExclusive<T>(resourceKey: string, operation: () => T | Promise<T>): Promise<T>
  /** Registers one cleanup per domain/resource key. Re-registering the same key is a no-op. */
  registerCleanup(key: string, callback: MaestroWorkerCleanup): void
  /** Waits for running resource operations, then runs every registered cleanup exactly once. */
  close(): Promise<void>
}

export interface CreateMaestroWorkerScopeOptions {
  conversationId: string
  delegationId: string
  label?: string
  signal?: AbortSignal
}

export function createMaestroWorkerScope(options: CreateMaestroWorkerScopeOptions): MaestroWorkerScope {
  const id = options.delegationId.trim()
  const conversationId = options.conversationId.trim()
  if (!id) throw new Error('Maestro worker scope requires a delegation id.')
  if (!conversationId) throw new Error('Maestro worker scope requires a conversation id.')

  const cleanupByKey = new Map<string, MaestroWorkerCleanup>()
  const tailsByResource = new Map<string, Promise<void>>()
  let closing = false
  let cleanupStarted = false
  let closePromise: Promise<void> | null = null

  const runExclusive = <T>(resourceKey: string, operation: () => T | Promise<T>): Promise<T> => {
    if (closing) return Promise.reject(new Error('Maestro worker scope is closed.'))

    const previous = tailsByResource.get(resourceKey) ?? Promise.resolve()
    const result = previous.then(() => {
      // An operation may have been admitted before a sibling on the same resource settled. Abort must be
      // re-checked when it actually reaches the head of the FIFO so cancelled work cannot produce late effects.
      options.signal?.throwIfAborted()
      return operation()
    })
    // Queue tails intentionally absorb operation failures: one failed operation must not poison the
    // FIFO for the next operation on the same resource.
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    tailsByResource.set(resourceKey, tail)
    void tail.then(() => {
      if (tailsByResource.get(resourceKey) === tail) tailsByResource.delete(resourceKey)
    })
    return result
  }

  const registerCleanup = (key: string, callback: MaestroWorkerCleanup): void => {
    if (cleanupByKey.has(key)) return
    // Running operations may still discover resources after close() was requested. close() waits for
    // their queues before crossing this boundary, so those registrations remain safe.
    if (cleanupStarted) throw new Error('Maestro worker scope cleanup has already started.')
    cleanupByKey.set(key, callback)
  }

  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    closing = true
    options.signal?.removeEventListener('abort', onAbort)
    closePromise = (async () => {
      // Snapshot repeatedly because an operation already running when close() began may enqueue work
      // on another resource before it settles.
      while (tailsByResource.size > 0) {
        await Promise.all([...tailsByResource.values()])
      }
      cleanupStarted = true
      const callbacks = [...cleanupByKey.values()]
      cleanupByKey.clear()
      const results = await Promise.allSettled(callbacks.map((callback) => callback()))
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason)
      if (errors.length > 0) throw new AggregateError(errors, 'Maestro worker scope cleanup failed.')
    })()
    return closePromise
  }

  function onAbort(): void {
    void close().catch(() => {
      // Abort cleanup is best-effort and has no awaiting caller. Explicit close() still exposes errors.
    })
  }

  const scope: MaestroWorkerScope = {
    id,
    conversationId,
    label: options.label?.trim() || id,
    signal: options.signal,
    runExclusive,
    registerCleanup,
    close,
  }

  if (options.signal?.aborted) queueMicrotask(onAbort)
  else options.signal?.addEventListener('abort', onAbort, { once: true })
  return scope
}
