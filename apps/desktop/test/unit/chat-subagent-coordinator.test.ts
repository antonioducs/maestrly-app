import { describe, expect, it } from 'vitest'
import { SubagentCoordinator } from '../../src/main/chat/subagent-coordinator'

describe('subagent coordinator', () => {
  it('admits dozens of children immediately without a host queue or concurrency cap', async () => {
    let peak = 0
    const coordinator = new SubagentCoordinator({
      onEvent: (event) => {
        if (event.type === 'acquired') peak = Math.max(peak, event.active)
      },
    })
    const signal = new AbortController().signal
    const leases = await Promise.all(
      Array.from({ length: 32 }, (_, index) => coordinator.acquire({ agent: `agent-${index}`, signal }))
    )
    expect(peak).toBe(32)
    for (const lease of leases) lease.release()
  })

  it('uses the parent signal as the shared kill switch for every admitted fake child', async () => {
    const coordinator = new SubagentCoordinator()
    const controller = new AbortController()
    let started = 0
    const children = Array.from({ length: 24 }, async (_, index) => {
      const lease = await coordinator.acquire({ agent: `agent-${index}`, signal: controller.signal })
      started += 1
      try {
        await new Promise<void>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      } finally {
        lease.release()
      }
    })
    await Promise.resolve()
    expect(started).toBe(24)
    controller.abort()
    const settled = await Promise.allSettled(children)
    expect(settled.every((result) => result.status === 'rejected')).toBe(true)
  })

  it('rejects an already aborted admission and releases idempotently', async () => {
    const coordinator = new SubagentCoordinator()
    const aborted = new AbortController()
    aborted.abort()
    await expect(coordinator.acquire({ agent: 'blocked', signal: aborted.signal })).rejects.toThrow(
      'Subagent coordination aborted'
    )
    const lease = await coordinator.acquire({ agent: 'active', signal: new AbortController().signal })
    lease.release()
    lease.release()
  })
})
