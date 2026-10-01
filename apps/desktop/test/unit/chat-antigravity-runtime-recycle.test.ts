import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AcpClient } from '../../src/main/chat/acp/client'
import type { AntigravityHostToolset } from '../../src/main/chat/antigravity-subscription/host-mcp'
import { createFakeAntigravity, FAKE_ACP_AGENT, type FakeAntigravity } from '../helpers/antigravity-fake'

let fake: FakeAntigravity
const unblock: Array<() => void> = []
beforeEach(() => {
  fake = createFakeAntigravity()
})
afterEach(async () => {
  for (const release of unblock.splice(0)) release()
  await fake.cleanup()
  vi.restoreAllMocks()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  unblock.push(resolve)
  return { promise, resolve }
}

describe('Antigravity runtime recycling', () => {
  it('keeps active requests and their lease, then starts the new version without signing out', async () => {
    let version = '1.2.1'
    const leases: ReturnType<typeof vi.fn>[] = []
    const manager = fake.manager({
      resolveRuntime: async () => {
        const release = vi.fn()
        leases.push(release)
        return { command: process.execPath, args: [FAKE_ACP_AGENT], version, source: 'managed', release }
      },
    })
    await manager.login()
    const identity = manager.getAccountIdentity()
    const releaseTurn = manager.retain()
    const first = await manager.connection()
    const disposeTools = vi.fn()
    manager.setLiveSession('conversation', {
      sessionId: 'session',
      generation: first.generation,
      toolset: { dispose: disposeTools } as unknown as AntigravityHostToolset,
      toolSignature: 'tools',
      instructionHash: 'instructions',
      modelValue: null,
    })
    version = '1.2.2'
    const selected = process.execPath + '.new'
    expect(await manager.recycleRuntime(selected, manager.runtimeUseCount)).toBe(false)
    expect(first.client.alive).toBe(true)
    expect(leases[1]).not.toHaveBeenCalled()
    releaseTurn()
    expect(await manager.recycleRuntime(selected, manager.runtimeUseCount)).toBe(true)
    await first.client.exited
    expect(leases[1]).toHaveBeenCalledTimes(1)
    expect(disposeTools).toHaveBeenCalledTimes(1)
    expect(manager.getAccountIdentity()).toEqual(identity)
    expect(manager.getStatus().authenticated).toBe(true)
    const second = await manager.connection()
    expect(second.generation).toBeGreaterThan(first.generation)
    expect(manager.connectedRuntime).toMatchObject({ version: '1.2.2', source: 'managed' })
    expect(fake.requests('authenticate')).toHaveLength(1)
  })

  it('does not recycle a request admitted after the environment idle snapshot, even if it already ended', async () => {
    const manager = fake.manager()
    await manager.login()
    const first = await manager.connection()
    const idleSnapshot = manager.runtimeUseCount
    const releaseTurn = manager.retain()
    await manager.connection()
    releaseTurn()
    expect(await manager.recycleRuntime(process.execPath + '.new', idleSnapshot)).toBe(false)
    expect(first.client.alive).toBe(true)
    expect(await manager.recycleRuntime(process.execPath, manager.runtimeUseCount)).toBe(true)
    expect(first.client.alive).toBe(true)
  })

  it('retries a connection that was still being established when an update arrived', async () => {
    const manager = fake.manager()
    await manager.login()
    const gate = deferred()
    const start = AcpClient.start
    const handshake = vi.spyOn(AcpClient, 'start').mockImplementationOnce(async (...args) => {
      await gate.promise
      return start(...args)
    })
    const pending = manager.connection()
    await vi.waitFor(() => expect(handshake).toHaveBeenCalledTimes(1))
    expect(manager.runtimeConnecting).toBe(true)
    expect(await manager.recycleRuntime(process.execPath + '.new', manager.runtimeUseCount)).toBe(false)
    gate.resolve()
    const first = await pending
    expect(manager.runtimeConnecting).toBe(false)
    expect(await manager.recycleRuntime(process.execPath + '.new', manager.runtimeUseCount)).toBe(true)
    expect(first.client.alive).toBe(false)
  })

  it('holds the lease until shutdown completes and makes new connections wait for it', async () => {
    const release = vi.fn()
    const manager = fake.manager({
      resolveRuntime: async () => ({ command: process.execPath, args: [FAKE_ACP_AGENT], release }),
    })
    await manager.login()
    release.mockClear()
    const first = await manager.connection()
    const gate = deferred()
    const close = first.client.close.bind(first.client)
    vi.spyOn(first.client, 'close').mockImplementationOnce(async () => {
      await gate.promise
      await close()
    })
    const recycling = manager.recycleRuntime(process.execPath + '.new', manager.runtimeUseCount)
    const next = manager.connection()
    expect(manager.runtimeConnecting).toBe(true)
    expect(release).not.toHaveBeenCalled()
    expect(fake.requests('initialize')).toHaveLength(2)
    gate.resolve()
    await expect(recycling).resolves.toBe(true)
    const second = await next
    expect(second.generation).toBeGreaterThan(first.generation)
    expect(release).toHaveBeenCalledTimes(1)
  })
})
