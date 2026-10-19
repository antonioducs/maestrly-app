import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireSubagentSlot, setSubagentConcurrency } from '../../src/main/chat/subagent-concurrency'

const signal = () => new AbortController().signal
afterEach(() => ['a', 'b', 'c'].forEach((id) => setSubagentConcurrency(id, null)))

describe('subagent concurrency', () => {
  it('does not limit unregistered conversations', async () => {
    const releases = await Promise.all([1, 2, 3].map(() => acquireSubagentSlot('free', signal())))
    expect(releases).toHaveLength(3)
  })

  it('shares one limit between the conversations of a pool and starts the next one on release', async () => {
    setSubagentConcurrency('a', { pool: 'bot', limit: 2 })
    setSubagentConcurrency('b', { pool: 'bot', limit: 2 })
    const first = await acquireSubagentSlot('a', signal())
    await acquireSubagentSlot('b', signal())
    const onWait = vi.fn()
    let third = false
    const pending = acquireSubagentSlot('a', signal(), onWait).then((release) => {
      third = true
      return release
    })
    await Promise.resolve()
    expect(onWait).toHaveBeenCalledOnce()
    expect(third).toBe(false)
    first()
    await pending
    expect(third).toBe(true)
  })

  it('drops a waiter whose signal aborts, without taking a slot', async () => {
    setSubagentConcurrency('c', { pool: 'solo', limit: 1 })
    const release = await acquireSubagentSlot('c', signal())
    const controller = new AbortController()
    const waiting = acquireSubagentSlot('c', controller.signal)
    controller.abort()
    await expect(waiting).rejects.toBeTruthy()
    release()
    const next = await acquireSubagentSlot('c', signal())
    next()
  })

  it('applies a raised limit to waiting tasks', async () => {
    setSubagentConcurrency('a', { pool: 'grow', limit: 1 })
    await acquireSubagentSlot('a', signal())
    const waiting = acquireSubagentSlot('a', signal())
    setSubagentConcurrency('a', { pool: 'grow', limit: 2 })
    await expect(waiting).resolves.toBeTypeOf('function')
  })
})
