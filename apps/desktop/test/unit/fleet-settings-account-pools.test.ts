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

import { addSubscriptionAccount, removeSubscriptionAccount } from '../../src/main/chat/catalog'
import { freezeFailoverChain } from '../../src/main/chat/subscription-failover/config'
import { removeAccountFromAccountPools } from '../../src/main/chat/subscription-failover/account-pool'
import { createAccountPoolsSettingsService } from '../../src/main/fleet/instance/settings/account-pools'
import type { SettingsBotUsage } from '../../src/main/fleet/instance/settings/models'

const CLAUDE = 'builtin_claude_subscription'
const ACTIVE = `${CLAUDE}@~active`

let bots: SettingsBotUsage[] = []
const accountsChanged = vi.fn()
const service = () => createAccountPoolsSettingsService({ bots: () => bots, accountsChanged })

beforeEach(() => {
  freshDb()
  bots = []
  accountsChanged.mockClear()
})
afterEach(() => closeDb())

describe('environment account pool settings', () => {
  it('lists a rotation once a kind has two accounts, with the bots that rotate and the ones fixed', async () => {
    const { accountPools } = service()
    expect((await accountPools({})).pools).toEqual([])
    const second = addSubscriptionAccount('claude-subscription', 'Claude 2').id
    bots = [
      { id: 'bot_a', name: 'Ana', selection: { providerId: ACTIVE, modelId: 'opus' } },
      { id: 'bot_b', name: 'Bia', selection: { providerId: `${CLAUDE}@${second}`, modelId: 'sonnet' } },
      { id: 'bot_c', name: 'Cid', selection: { providerId: 'builtin_codex_subscription', modelId: 'gpt' } },
    ]
    const read = await accountPools({})
    expect(FLEET_SETTINGS_OPERATIONS.accountPools.response.parse(read)).toEqual(read)
    expect(read.pools).toEqual([
      {
        kind: 'claude',
        enabled: true,
        policy: 'drain',
        autoJoin: true,
        members: [null, second],
        active: null,
        current: null,
        limited: [],
        bots: [{ id: 'bot_a', name: 'Ana' }],
        pinned: [{ id: 'bot_b', name: 'Bia', slot: second, modelId: 'sonnet' }],
        switches: [],
      },
    ])
  })

  it('saves the rotation the active-account turns then follow', async () => {
    const second = addSubscriptionAccount('claude-subscription', 'Claude 2').id
    const third = addSubscriptionAccount('claude-subscription', 'Claude 3').id
    const { accountPools, setAccountPool } = service()
    const before = await accountPools({})
    const saved = await setAccountPool({
      kind: 'claude',
      expectedRevision: before.revision,
      members: [third, null, second],
      active: null,
      policy: 'prefer-active',
    })
    expect(saved.revision).not.toBe(before.revision)
    expect(saved.pools[0]).toMatchObject({
      members: [third, null, second],
      active: null,
      policy: 'prefer-active',
      autoJoin: true,
      switches: [],
    })
    expect(accountsChanged).toHaveBeenCalledTimes(1)
    // The chain a bot turn freezes at its start: the active account first, then the others in order.
    expect(freezeFailoverChain(ACTIVE)).toEqual([CLAUDE, `${CLAUDE}@${second}`, `${CLAUDE}@${third}`])

    const moved = await setAccountPool({ kind: 'claude', expectedRevision: saved.revision, active: second })
    expect(moved.pools[0]).toMatchObject({ active: second, switches: [{ from: null, to: second, reason: 'manual' }] })
    const off = await setAccountPool({ kind: 'claude', expectedRevision: moved.revision, enabled: false })
    expect(off.pools[0]?.enabled).toBe(false)
    expect(freezeFailoverChain(ACTIVE)).toEqual([`${CLAUDE}@${second}`])
  })

  it('refuses a stale revision, an account the environment does not have, and a kind without a rotation', async () => {
    const second = addSubscriptionAccount('claude-subscription', 'Claude 2').id
    const { accountPools, setAccountPool } = service()
    const { revision } = await accountPools({})
    await setAccountPool({ kind: 'claude', expectedRevision: revision, autoJoin: false })
    await expect(setAccountPool({ kind: 'claude', expectedRevision: revision, active: second })).rejects.toMatchObject({
      status: 409,
      code: 'CONFLICT',
    })
    const current = (await accountPools({})).revision
    await expect(
      setAccountPool({ kind: 'claude', expectedRevision: current, members: [null, 'acc_missing'] })
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
    // A Codex account never joins the Claude rotation.
    const codex = addSubscriptionAccount('codex-subscription', 'Codex 2').id
    await expect(
      setAccountPool({ kind: 'claude', expectedRevision: (await accountPools({})).revision, members: [null, codex] })
    ).rejects.toMatchObject({ status: 404 })
    removeSubscriptionAccount(codex)
    await expect(
      setAccountPool({ kind: 'codex', expectedRevision: (await accountPools({})).revision, enabled: false })
    ).rejects.toMatchObject({ status: 404 })
  })

  it('drops a removed account from the rotation it reads', async () => {
    const second = addSubscriptionAccount('claude-subscription', 'Claude 2').id
    const third = addSubscriptionAccount('claude-subscription', 'Claude 3').id
    const { accountPools, setAccountPool } = service()
    await setAccountPool({
      kind: 'claude',
      expectedRevision: (await accountPools({})).revision,
      members: [second, third],
      active: third,
    })
    const before = await accountPools({})
    removeSubscriptionAccount(third)
    removeAccountFromAccountPools(`${CLAUDE}@${third}`)
    const after = await accountPools({})
    expect(after.pools[0]).toMatchObject({ members: [second], active: second })
    expect(after.revision).not.toBe(before.revision)
  })

  it('validates rotation input at the protocol boundary', () => {
    const revision = '550e8400-e29b-41d4-a716-446655440000'
    const input = FLEET_SETTINGS_OPERATIONS.setAccountPool.input
    expect(input.safeParse({ kind: 'claude', expectedRevision: revision, members: [null, 'acc_a'] }).success).toBe(true)
    expect(input.safeParse({ kind: 'claude', expectedRevision: revision, members: ['acc_a', 'acc_a'] }).success).toBe(
      false
    )
    expect(input.safeParse({ kind: 'claude', expectedRevision: revision, members: [] }).success).toBe(false)
    expect(input.safeParse({ kind: 'claude', expectedRevision: revision, policy: 'sometimes' }).success).toBe(false)
    expect(input.safeParse({ kind: 'grok', expectedRevision: revision, enabled: true }).success).toBe(false)
  })
})
