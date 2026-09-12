import { describe, expect, it, vi } from 'vitest'
import { createTestRegistrar } from './ipc-registrar-test-utils'

vi.mock('../../src/main/conflict-resolver', () => ({
  resolveReviewConflicts: vi.fn(),
}))

vi.mock('../../src/main/gh-service', () => ({
  getReviewData: vi.fn(),
}))

import { registerReviewIpc } from '../../src/main/review-ipc'

describe('registerReviewIpc', () => {
  it('registers review tab channels with the expected registrars', () => {
    const { reg, handles, mhandles, ons, mons } = createTestRegistrar()

    registerReviewIpc(reg)

    expect([...handles.keys()]).toEqual(['review:get'])
    expect([...mhandles.keys()]).toEqual(['review:resolve-conflicts'])
    expect(ons.size).toBe(0)
    expect(mons.size).toBe(0)
  })
})
