import { describe, expect, it, vi } from 'vitest'
import { createClaudeToolJournal } from '../../src/main/chat/claude-agent-sdk/tool-journal'

const signal = () => new AbortController().signal

describe('Claude tool journal', () => {
  it('deduplicates IDs with canonical input and isolates snapshots', async () => {
    const onEntry = vi.fn()
    const journal = createClaudeToolJournal({ attemptId: 'a', onEntry })
    const execute = vi.fn(async () => 'done')
    const first = journal.run('id', 'write', { a: 1, b: 2 }, execute)
    expect(journal.run('id', 'write', { b: 2, a: 1 }, execute)).toBe(first)
    const running = journal.snapshot()
    await first
    expect(running[0].state).toBe('running')
    expect(Object.isFrozen(running[0].input)).toBe(true)
    expect(journal.snapshot()[0]).toMatchObject({ state: 'completed', output: 'done' })
    expect(onEntry).toHaveBeenCalledTimes(2)
    journal.stopAccepting()
    expect(journal.run('id', 'write', { a: 1, b: 2 }, execute)).toBe(first)
    await expect(journal.run('new', 'write', {}, execute)).rejects.toThrow('no longer accepting')
    await expect(journal.run('id', 'write', {}, execute)).rejects.toThrow('Conflicting')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('distinguishes known error output from uncertain effects', async () => {
    const journal = createClaudeToolJournal({ attemptId: 'a' })
    await journal.run('failed', 'write', {}, async () => ({ text: 'denied', isError: true }))
    await expect(
      journal.run('uncertain', 'write', {}, async () => {
        throw new Error('lost')
      })
    ).rejects.toThrow('lost')
    expect(journal.snapshot().map((entry) => entry.state)).toEqual(['failed', 'uncertain'])
    await journal.drain(signal())
  })

  it('waits without a short timeout and retains late completion after cancelled drain', async () => {
    vi.useFakeTimers()
    try {
      const onEntry = vi.fn()
      const journal = createClaudeToolJournal({ attemptId: 'a', onEntry })
      let finish!: (value: string) => void
      const pending = journal.run(
        'child',
        'task',
        {},
        () =>
          new Promise<string>((resolve) => {
            finish = resolve
          })
      )
      journal.stopAccepting()
      const controller = new AbortController()
      const settled = vi.fn()
      const drain = journal.drain(controller.signal)
      void drain.then(settled, () => {})
      await vi.advanceTimersByTimeAsync(600_000)
      expect(settled).not.toHaveBeenCalled()
      controller.abort(new Error('cancelled'))
      await expect(drain).rejects.toThrow('cancelled')
      finish('child completed')
      await pending
      await journal.drain(signal())
      expect(onEntry).toHaveBeenLastCalledWith(
        expect.objectContaining({ state: 'completed', output: 'child completed' })
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('retains canonical completion when the durable callback fails', async () => {
    const journal = createClaudeToolJournal({
      attemptId: 'a',
      onEntry: (entry) => {
        if (entry.state === 'completed') throw new Error('persistence failed')
      },
    })
    await expect(journal.run('id', 'write', {}, async () => 'effect finished')).rejects.toThrow('persistence failed')
    expect(journal.snapshot()[0]).toMatchObject({ state: 'completed', output: 'effect finished' })
  })
})

it('keeps ownership while projection runs after a durable host result', async () => {
  const journal = createClaudeToolJournal({ attemptId: 'projection' })
  let release!: () => void
  const projection = new Promise<void>((resolve) => {
    release = resolve
  })
  const callback = journal.track(async () => {
    await journal.run('tool', 'write', {}, async () => 'saved')
    await projection
  })
  await vi.waitFor(() => expect(journal.snapshot()[0]?.state).toBe('completed'))
  journal.stopAccepting()
  let drained = false
  const drain = journal.drain(new AbortController().signal).then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(drained).toBe(false)
  release()
  await Promise.all([callback, drain])
  expect(drained).toBe(true)
})
