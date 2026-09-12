import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetCwdActivityForTests,
  inspectCwdActivity,
  registerIdleCwdResource,
  setOwnedCwdActivity,
  tryAcquireCwdActivity,
  tryAcquireLongCwdLease,
  cwdLeaseOwner,
  tryWithCwdExclusive,
  waitForCwdActivityDrain,
} from '../../src/main/cwd-activity-coordinator'

afterEach(__resetCwdActivityForTests)

describe('cwd activity coordinator', () => {
  it('waits for events until already admitted activities drain', async () => {
    const releasePty = tryAcquireCwdActivity('/tmp/repo', 'pty')
    const releaseChat = tryAcquireCwdActivity('/tmp/repo', 'chat')
    let settled = false
    const drained = waitForCwdActivityDrain('/tmp/repo', ['pty', 'chat']).then((value) => {
      settled = true
      return value
    })

    releasePty?.()
    await Promise.resolve()
    expect(settled).toBe(false)
    releaseChat?.()
    await expect(drained).resolves.toBe(true)
  })

  it('fails closed when admitted activity does not drain before the deadline', async () => {
    const release = tryAcquireCwdActivity('/tmp/repo', 'pty')
    await expect(waitForCwdActivityDrain('/tmp/repo', ['pty'], 5)).resolves.toBe(false)
    release?.()
  })

  it.each([
    'pty',
    'chat',
    'terminal',
  ] as const)('blocks deletion with provable %s activity and releases idempotently', async (kind) => {
    const release = tryAcquireCwdActivity('/tmp/repo', kind)
    expect(release).toBeTypeOf('function')
    expect(await tryWithCwdExclusive('/tmp/repo', async () => 1)).toMatchObject({
      ok: false,
      reason: 'active',
    })
    release?.()
    release?.()
    expect(await tryWithCwdExclusive('/tmp/repo', async () => 1)).toEqual({ ok: true, value: 1 })
    expect(inspectCwdActivity('/tmp/repo')).toEqual([])
  })

  it('an idle resource appears as a warning without blocking', async () => {
    const release = registerIdleCwdResource('/tmp/repo', 'terminal')
    expect(inspectCwdActivity('/tmp/repo')).toEqual([{ kind: 'terminal', count: 1, blocking: false }])
    expect(await tryWithCwdExclusive('/tmp/repo', async () => 'ok')).toEqual({ ok: true, value: 'ok' })
    release()
  })

  it('can serialize a short attach while ignoring activity but still blocks another deletion', async () => {
    const release = tryAcquireCwdActivity('/tmp/repo', 'chat')
    const result = await tryWithCwdExclusive(
      '/tmp/repo',
      async () => {
        expect(await tryWithCwdExclusive('/tmp/repo', async () => 'concorrente')).toMatchObject({
          ok: false,
          reason: 'exclusive',
        })
        return 'attach'
      },
      { allowActivity: true }
    )

    expect(result).toEqual({ ok: true, value: 'attach' })
    release?.()
  })

  it('long activity per owner is idempotent and blocks until final status', async () => {
    expect(setOwnedCwdActivity('pty:c1', '/tmp/a', 'pty', true)).toBe(true)
    expect(setOwnedCwdActivity('pty:c1', '/tmp/a', 'pty', true)).toBe(true)
    expect(inspectCwdActivity('/tmp/a')).toEqual([{ kind: 'pty', count: 1, blocking: true }])
    expect(await tryWithCwdExclusive('/tmp/a', async () => 'no')).toMatchObject({ ok: false })
    expect(setOwnedCwdActivity('pty:c1', '/tmp/a', 'pty', false)).toBe(true)
    expect(setOwnedCwdActivity('pty:c1', '/tmp/a', 'pty', false)).toBe(true)
    expect(await tryWithCwdExclusive('/tmp/a', async () => 'ok')).toEqual({ ok: true, value: 'ok' })
  })

  it('deletion prevents new execution while a different cwd remains independent', async () => {
    let blocked: ReturnType<typeof tryAcquireCwdActivity> | undefined
    const result = await tryWithCwdExclusive('/tmp/a', async () => {
      blocked = tryAcquireCwdActivity('/tmp/a', 'pty')
      const other = tryAcquireCwdActivity('/tmp/b', 'chat')
      expect(other).toBeTypeOf('function')
      other?.()
      return 7
    })
    expect(blocked).toBeNull()
    expect(result).toEqual({ ok: true, value: 7 })
  })

  it('the review-loop lease permits only its two internal owners and blocks third parties', () => {
    const owner = 'review-loop:rl_pair_1'
    const reviewer = `${owner}:reviewer`
    const executor = `${owner}:executor`
    const lease = tryAcquireLongCwdLease('/tmp/review', owner, [reviewer, executor])
    expect(lease).not.toBeNull()
    expect(cwdLeaseOwner('/tmp/review')).toBe(owner)
    expect(tryAcquireCwdActivity('/tmp/review', 'chat')).toBeNull()
    expect(tryAcquireCwdActivity('/tmp/review', 'terminal', 'terminal:third')).toBeNull()
    const releaseReviewer = tryAcquireCwdActivity('/tmp/review', 'chat', reviewer)
    const releaseExecutor = tryAcquireCwdActivity('/tmp/review', 'chat', executor)
    expect(releaseReviewer).toBeTypeOf('function')
    expect(releaseExecutor).toBeTypeOf('function')
    releaseReviewer?.()
    releaseExecutor?.()
    lease?.release()
    expect(cwdLeaseOwner('/tmp/review')).toBeNull()
    const releaseThird = tryAcquireCwdActivity('/tmp/review', 'chat')
    expect(releaseThird).toBeTypeOf('function')
    releaseThird?.()
  })

  it('a long lease fails closed in the presence of already admitted activity', () => {
    const release = tryAcquireCwdActivity('/tmp/review-busy', 'pty')
    expect(tryAcquireLongCwdLease('/tmp/review-busy', 'review-loop:busy')).toBeNull()
    release?.()
  })
})
