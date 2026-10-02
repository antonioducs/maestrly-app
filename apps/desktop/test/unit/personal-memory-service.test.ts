import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { personalMemoryService as service } from '../../src/main/memory/personal-memory-service'
import { createLocalMemory } from '../../src/main/memory/local-memory-service'
import { setPersonalMemorySettings } from '../../src/main/memory/personal-memory-settings'
import { PERSONAL_MEMORY_SPACE_ID } from '../../src/shared/memory'
import { closeDb, freshDb } from '../helpers/db'

vi.mock('../../src/main/memory/index', () => ({
  getMemoryIndexStatus: vi.fn().mockResolvedValue({ state: 'idle' }),
  rebuildMemoryIndex: vi.fn().mockResolvedValue(undefined),
}))
import { getMemoryIndexStatus, rebuildMemoryIndex } from '../../src/main/memory/index'

beforeEach(() => freshDb())
afterEach(() => closeDb())
const input = { title: 'Synthetic preference', content: 'Prefer concise summaries.', type: 'preference' }

describe('personal memory management', () => {
  it('searches only personal records while disabled and validates query and filters', () => {
    setPersonalMemorySettings({ enabled: false, autoRecall: false, extraction: { enabled: false, selection: null } })
    const { memory } = service.create(input)
    createLocalMemory({ ...input, type: 'preference', workspaceId: 'synthetic-project', source: 'user' })
    expect(service.search('concise')).toEqual([memory])
    expect(service.search('concise', { pinned: true })).toEqual([])
    expect(service.search('concise', { type: 'preference', status: 'active' })).toEqual([memory])
    for (const query of ['', ' '.repeat(3), 'x'.repeat(1001), null, 123]) expect(() => service.search(query)).toThrow()
    for (const filters of [
      { workspaceId: 'project' },
      { repositoryRoot: '/tmp' },
      { limit: 501 },
      { pinned: 'yes' },
      { type: 'invalid' },
    ]) {
      expect(() => service.search('concise', filters)).toThrow()
    }
  })
  it('fixes index operations to personal memory and supplies no repository roots', async () => {
    await service.indexStatus()
    await service.rebuild()
    expect(getMemoryIndexStatus).toHaveBeenCalledWith(PERSONAL_MEMORY_SPACE_ID)
    expect(rebuildMemoryIndex).toHaveBeenCalledWith(PERSONAL_MEMORY_SPACE_ID, [])
  })

  it('owns space and source and rejects scope injection', () => {
    const { memory } = service.create(input)
    expect(memory.workspaceId).toBe(PERSONAL_MEMORY_SPACE_ID)
    expect(memory.source).toBe('user')
    for (const extra of [{ workspaceId: 'project' }, { source: 'agent' }, { originConversationId: 'forged' }]) {
      expect(() => service.create({ ...input, ...extra })).toThrow()
      expect(() => service.update(memory.id, extra)).toThrow()
    }
  })
  it('manages disabled memory and requires deletion confirmation', () => {
    setPersonalMemorySettings({ enabled: false, autoRecall: false, extraction: { enabled: false, selection: null } })
    const { memory } = service.create(input)
    service.update(memory.id, { pinned: true })
    expect(service.get(memory.id)?.pinned).toBe(true)
    service.archive(memory.id)
    expect(service.get(memory.id)?.status).toBe('archived')
    service.restore(memory.id)
    expect(service.get(memory.id)?.status).toBe('active')
    expect(() => service.forget(memory.id, 'true')).toThrow('confirmation-required')
    service.forget(memory.id, true)
    expect(service.get(memory.id)).toBeUndefined()
  })
  it('exports records beyond the first page', () => {
    for (let index = 0; index < 501; index++) service.create({ ...input, content: `Synthetic preference ${index}` })
    expect(service.list({ limit: 500 })).toHaveLength(500)
    expect(JSON.parse(service.export().json).memories).toHaveLength(501)
  })
  it('isolates project records and paginates lists', () => {
    const foreign = createLocalMemory({
      ...input,
      type: 'preference',
      workspaceId: 'synthetic-project',
      source: 'user',
    }).memory
    service.create(input)
    service.create({ ...input, content: 'Prefer synthetic examples.' })
    expect(service.get(foreign.id)).toBeUndefined()
    expect(() => service.update(foreign.id, { title: 'Forbidden' })).toThrow()
    expect(service.list({ limit: 1 })).toHaveLength(1)
    expect(service.list({ limit: 1, offset: 1 })).toHaveLength(1)
    expect(service.list({ offset: 2 })).toHaveLength(0)
    expect(JSON.parse(service.export().json).memories).toHaveLength(2)
    expect(() => service.list({ offset: -1 })).toThrow()
  })
})
