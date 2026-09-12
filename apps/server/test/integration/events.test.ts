import { describe, expect, it } from 'vitest'
import { inTenantTransaction } from '../../src/db/transaction.js'
import { appendDomainEvent, listDomainEvents } from '../../src/modules/events/store.js'
import { createProject } from '../../src/modules/projects/service.js'
import { integrationAvailable, runtimePool, seedOrganization } from './helpers.js'

describe.skipIf(!integrationAvailable)('durable project event order', () => {
  it('serializes project sequence assignment across concurrent commits', async () => {
    const pool = runtimePool()
    try {
      const suffix = crypto.randomUUID(); const owner = `owner-${suffix}`
      const organizationId = await seedOrganization(`Events ${suffix}`, owner)
      const { project } = await createProject(pool, { organizationId, actorUserId: owner, name: 'Events' })
      let releaseFirst!: () => void
      let firstAppended!: () => void
      const appended = new Promise<void>((resolve) => { firstAppended = resolve })
      const release = new Promise<void>((resolve) => { releaseFirst = resolve })
      const first = inTenantTransaction(pool, { organizationId, projectId: project.id, actor: { type: 'human', userId: owner } }, async (client) => {
        const event = await appendDomainEvent(client, { organizationId, projectId: project.id, type: 'test.first', aggregateType: 'project', aggregateId: project.id, actor: { type: 'human', userId: owner } })
        firstAppended(); await release; return event
      })
      await appended
      const second = inTenantTransaction(pool, { organizationId, projectId: project.id, actor: { type: 'human', userId: owner } }, (client) => appendDomainEvent(client, {
        organizationId, projectId: project.id, type: 'test.second', aggregateType: 'project', aggregateId: project.id, actor: { type: 'human', userId: owner },
      }))
      releaseFirst()
      const [firstEvent, secondEvent] = await Promise.all([first, second])
      expect(secondEvent.sequence).toBe(firstEvent.sequence + 1)
      const events = await listDomainEvents(pool, { organizationId, projectId: project.id, cursor: firstEvent.sequence - 1, actor: { type: 'human', userId: owner } })
      expect(events.slice(0, 2).map((event) => event.type)).toEqual(['test.first', 'test.second'])
    } finally { await pool.end() }
  })
})
