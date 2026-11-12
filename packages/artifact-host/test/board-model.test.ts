import { describe, expect, it } from 'vitest'
import { createBoardPoller } from '../src/shell/board-model.js'

describe('board poller', () => {
  it('starts from revision 0 at once and follows the revisions it is told', () => {
    const poller = createBoardPoller()
    expect(poller.next()).toEqual({ since: 0, delayMs: 0 })
    poller.result({ status: 200, revision: 7 })
    expect(poller.next()).toEqual({ since: 7, delayMs: 0 })
  })

  it('waits longer after each failure, up to thirty seconds, and recovers', () => {
    const poller = createBoardPoller()
    poller.result({ status: 200, revision: 3 })
    const delays: number[] = []
    for (const status of [503, 503, 503]) {
      poller.result({ status })
      delays.push(poller.next()!.delayMs)
    }
    expect(delays).toEqual([1000, 2000, 4000])
    for (let i = 0; i < 30; i++) poller.result({ status: i % 2 ? 0 : 429 })
    expect(poller.next()!.delayMs).toBeLessThanOrEqual(30_000)
    expect(poller.next()).toEqual({ since: 3, delayMs: 30_000 })
    poller.result({ status: 200, revision: 4 })
    expect(poller.next()).toEqual({ since: 4, delayMs: 0 })
  })

  it('stops once the board is gone', () => {
    const poller = createBoardPoller()
    poller.result({ status: 404 })
    expect(poller.next()).toBeNull()
    poller.result({ status: 200, revision: 9 })
    expect(poller.next()).toBeNull()
  })
})
