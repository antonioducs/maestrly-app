import { describe, expect, it, vi } from 'vitest'
import { createMaestroWorkerScope } from '../../src/main/maestro-worker-scope'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('MaestroWorkerScope', () => {
  it('runs one FIFO per resource while different resources remain parallel', async () => {
    const scope = createMaestroWorkerScope({ conversationId: 'conv-1', delegationId: 'delegate-1' })
    const firstGate = deferred()
    const events: string[] = []

    const first = scope.runExclusive('tab-a', async () => {
      events.push('a1:start')
      await firstGate.promise
      events.push('a1:end')
    })
    const second = scope.runExclusive('tab-a', async () => {
      events.push('a2:start')
      events.push('a2:end')
    })
    const other = scope.runExclusive('tab-b', async () => {
      events.push('b:start')
      events.push('b:end')
    })

    await other
    expect(events).toEqual(['a1:start', 'b:start', 'b:end'])

    firstGate.resolve()
    await Promise.all([first, second])
    expect(events).toEqual(['a1:start', 'b:start', 'b:end', 'a1:end', 'a2:start', 'a2:end'])
    await scope.close()
  })

  it('waits for running work and runs keyed cleanup once across repeated close calls', async () => {
    const scope = createMaestroWorkerScope({ conversationId: 'conv-1', delegationId: 'delegate-close' })
    const operationGate = deferred()
    const cleanup = vi.fn()
    const ignoredDuplicate = vi.fn()
    scope.registerCleanup('browser', cleanup)
    scope.registerCleanup('browser', ignoredDuplicate)

    const operation = scope.runExclusive('browser:tab-1', () => operationGate.promise)
    const closeA = scope.close()
    const closeB = scope.close()
    expect(cleanup).not.toHaveBeenCalled()

    operationGate.resolve()
    await operation
    await Promise.all([closeA, closeB])
    expect(cleanup).toHaveBeenCalledOnce()
    expect(ignoredDuplicate).not.toHaveBeenCalled()
    await expect(scope.runExclusive('browser:tab-1', () => undefined)).rejects.toThrow('closed')
  })

  it('runs the same idempotent cleanup path when its abort signal fires', async () => {
    const controller = new AbortController()
    const scope = createMaestroWorkerScope({
      conversationId: 'conv-1',
      delegationId: 'delegate-abort',
      signal: controller.signal,
    })
    const cleanup = vi.fn()
    scope.registerCleanup('terminal', cleanup)

    controller.abort()
    controller.abort()
    await scope.close()
    await scope.close()

    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('does not start queued resource work after the worker is aborted', async () => {
    const controller = new AbortController()
    const scope = createMaestroWorkerScope({
      conversationId: 'conv-1',
      delegationId: 'delegate-queued-abort',
      signal: controller.signal,
    })
    const firstGate = deferred()
    const firstStarted = deferred()
    const lateEffect = vi.fn()
    const first = scope.runExclusive('terminal:one', async () => {
      firstStarted.resolve()
      await firstGate.promise
    })
    const queued = scope.runExclusive('terminal:one', lateEffect)
    const queuedError = queued.then(
      () => null,
      (error: unknown) => error
    )

    await firstStarted.promise
    controller.abort()
    firstGate.resolve()
    await first
    await expect(queuedError).resolves.toMatchObject({ name: 'AbortError' })
    await scope.close()

    expect(lateEffect).not.toHaveBeenCalled()
  })

  it('does not poison cleanup when a resource operation fails', async () => {
    const scope = createMaestroWorkerScope({ conversationId: 'conv-1', delegationId: 'delegate-error' })
    const cleanup = vi.fn()
    scope.registerCleanup('resource', cleanup)

    await expect(
      scope.runExclusive('resource', async () => {
        throw new Error('operation failed')
      })
    ).rejects.toThrow('operation failed')
    await scope.close()

    expect(cleanup).toHaveBeenCalledOnce()
  })
})
