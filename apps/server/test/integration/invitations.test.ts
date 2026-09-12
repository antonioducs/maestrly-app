import { describe, expect, it } from 'vitest'
import { acceptInvitation, createInvitation, inspectInvitation } from '../../src/modules/access/invitations.js'
import { integrationAvailable, runtimePool, seedOrganization } from './helpers.js'

describe.skipIf(!integrationAvailable)('invitations', () => {
  it('rejects expired, tampered, and reused invitation tokens', async () => {
    const pool = runtimePool()
    try {
      const suffix = crypto.randomUUID()
      const owner = `owner-${suffix}`
      const organizationId = await seedOrganization(`Invites ${suffix}`, owner)
      const expired = await createInvitation(pool, {
        organizationId, email: 'expired@example.test', role: 'member', expiresAt: new Date(Date.now() - 1_000), createdByUserId: owner,
      })
      await expect(inspectInvitation(pool, { organizationId, token: expired.token, email: 'expired@example.test' })).resolves.toEqual({ valid: false })

      const active = await createInvitation(pool, {
        organizationId, email: 'member@example.test', role: 'member', expiresAt: new Date(Date.now() + 60_000), createdByUserId: owner,
      })
      await expect(inspectInvitation(pool, { organizationId, token: `${active.token}x`, email: 'member@example.test' })).resolves.toEqual({ valid: false })
      await acceptInvitation(pool, { organizationId, token: active.token, email: 'member@example.test', userId: `member-${suffix}` })
      await expect(acceptInvitation(pool, { organizationId, token: active.token, email: 'member@example.test', userId: `other-${suffix}` })).rejects.toThrow(/already used/)
    } finally { await pool.end() }
  })
})
