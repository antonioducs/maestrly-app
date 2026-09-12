import { describe, expect, it } from 'vitest'
import { getBoard } from '../../src/modules/boards/service.js'
import { createCard, updateCard } from '../../src/modules/cards/service.js'
import { createProject } from '../../src/modules/projects/service.js'
import { integrationAvailable, runtimePool, seedOrganization } from './helpers.js'

describe.skipIf(!integrationAvailable)('card concurrency', () => {
  it('accepts one optimistic edit and returns the current state for the conflicting edit', async () => {
    const pool = runtimePool()
    try {
      const suffix = crypto.randomUUID(); const owner = `owner-${suffix}`
      const organizationId = await seedOrganization(`Cards ${suffix}`, owner)
      const created = await createProject(pool, { organizationId, actorUserId: owner, name: 'Cards' })
      const board = await getBoard(pool, { organizationId, boardId: created.boardId, userId: owner })
      const card = await createCard(pool, { organizationId, boardId: created.boardId, userId: owner, title: 'Original' })
      const results = await Promise.allSettled([
        updateCard(pool, { organizationId, cardId: card.id, userId: owner, patch: { expectedVersion: 1, title: 'First edit' } }),
        updateCard(pool, { organizationId, cardId: card.id, userId: owner, patch: { expectedVersion: 1, title: 'Second edit' } }),
      ])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      const rejected = results.find((result) => result.status === 'rejected')
      expect(rejected?.status === 'rejected' ? rejected.reason.current.version : 0).toBe(2)
      expect(board.columns).toHaveLength(4)
    } finally { await pool.end() }
  })
})
