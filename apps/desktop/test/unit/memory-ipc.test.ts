import { describe, expect, it, vi } from 'vitest'
import { createTestRegistrar } from './ipc-registrar-test-utils'

vi.mock('../../src/main/memory-service', () => ({
  readMemory: vi.fn(),
  watchMemory: vi.fn(),
  writeMemory: vi.fn(),
}))

vi.mock('../../src/main/store', () => ({
  getMemoryEnabled: vi.fn(),
  setMemoryEnabled: vi.fn(),
}))

import { registerMemoryIpc } from '../../src/main/memory-ipc'

describe('registerMemoryIpc', () => {
  it('registers memory channels with the expected registrars', () => {
    const { reg, handles, mhandles, ons, mons } = createTestRegistrar()

    registerMemoryIpc(reg)

    expect([...handles.keys()].sort()).toEqual([
      'memory:enabled-get',
      'memory:export',
      'memory:get',
      'memory:index-status-get',
      'memory:legacy-backups',
      'memory:list',
      'memory:promotion-preview',
      'memory:read',
      'memory:search',
      'memory:shared-list',
    ])
    expect([...mhandles.keys()].sort()).toEqual([
      'memory:archive',
      'memory:create',
      'memory:forget',
      'memory:index-rebuild',
      'memory:legacy-backup-remove',
      'memory:promote',
      'memory:restore',
      'memory:shared-open',
      'memory:update',
    ])
    expect([...ons.keys()]).toEqual([])
    expect([...mons.keys()].sort()).toEqual(['memory:enabled-set', 'memory:write'])
  })
})
