import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLEET_SETTINGS_OPERATIONS } from '@maestrly/bot-fleet-protocol'
import { closeDb, freshDb } from '../helpers/db'

vi.mock('../../src/main/fleet/instance/server', () => ({
  InstanceHttpError: class extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string
    ) {
      super(message)
    }
  },
}))

import { addSubscriptionAccount } from '../../src/main/chat/catalog'
import { freezeFailoverChain, removeAccountFromFailoverConfig } from '../../src/main/chat/subscription-failover/config'
import { failover, setFailoverRoute } from '../../src/main/fleet/instance/settings/failover'

const CLAUDE = 'builtin_claude_subscription'

beforeEach(() => freshDb())
afterEach(() => closeDb())

describe('environment failover settings', () => {
  it('stores a route the bot turns of the environment then follow', async () => {
    const second = addSubscriptionAccount('claude-subscription', 'Claude 2').id
    const third = addSubscriptionAccount('claude-subscription', 'Claude 3').id
    const empty = await failover({})
    expect(FLEET_SETTINGS_OPERATIONS.failover.response.parse(empty)).toEqual({ revision: empty.revision, routes: [] })

    const saved = await setFailoverRoute({
      kind: 'claude',
      slot: null,
      expectedRevision: empty.revision,
      enabled: true,
      fallbacks: [third, second],
    })
    expect(saved.routes).toEqual([{ kind: 'claude', slot: null, enabled: true, fallbacks: [third, second] }])
    expect(saved.revision).not.toBe(empty.revision)
    // The chain a bot turn freezes at its start, primary first.
    expect(freezeFailoverChain(CLAUDE)).toEqual([CLAUDE, `${CLAUDE}@${third}`, `${CLAUDE}@${second}`])
  })

  it('refuses a stale revision and an account the environment does not have', async () => {
    const second = addSubscriptionAccount('claude-subscription', 'Claude 2').id
    const { revision } = await failover({})
    await setFailoverRoute({ kind: 'claude', slot: second, expectedRevision: revision, enabled: false, fallbacks: [] })
    await expect(
      setFailoverRoute({ kind: 'claude', slot: second, expectedRevision: revision, enabled: true, fallbacks: [null] })
    ).rejects.toMatchObject({ status: 409, code: 'CONFLICT' })

    const current = await failover({})
    await expect(
      setFailoverRoute({
        kind: 'claude',
        slot: null,
        expectedRevision: current.revision,
        enabled: true,
        fallbacks: ['acc_missing'],
      })
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    // A Codex account is never a fallback of a Claude account.
    const codex = addSubscriptionAccount('codex-subscription', 'Codex 2').id
    await expect(
      setFailoverRoute({
        kind: 'claude',
        slot: null,
        expectedRevision: (await failover({})).revision,
        enabled: true,
        fallbacks: [codex],
      })
    ).rejects.toMatchObject({ status: 404 })
  })

  it('drops a removed account from the routes it reads', async () => {
    const second = addSubscriptionAccount('codex-subscription', 'Codex 2').id
    const { revision } = await failover({})
    await setFailoverRoute({
      kind: 'codex',
      slot: null,
      expectedRevision: revision,
      enabled: true,
      fallbacks: [second],
    })
    const before = await failover({})
    removeAccountFromFailoverConfig(`builtin_codex_subscription@${second}`)
    const after = await failover({})
    expect(after.routes).toEqual([{ kind: 'codex', slot: null, enabled: true, fallbacks: [] }])
    expect(after.revision).not.toBe(before.revision)
  })

  it('validates route input at the protocol boundary', () => {
    const revision = '550e8400-e29b-41d4-a716-446655440000'
    const input = FLEET_SETTINGS_OPERATIONS.setFailoverRoute.input
    expect(
      input.safeParse({ kind: 'claude', slot: null, expectedRevision: revision, enabled: true, fallbacks: [null] })
        .success
    ).toBe(false)
    expect(
      input.safeParse({
        kind: 'claude',
        slot: null,
        expectedRevision: revision,
        enabled: true,
        fallbacks: ['acc_a', 'acc_a'],
      }).success
    ).toBe(false)
    expect(
      input.safeParse({ kind: 'grok', slot: null, expectedRevision: revision, enabled: true, fallbacks: [] }).success
    ).toBe(false)
  })
})
