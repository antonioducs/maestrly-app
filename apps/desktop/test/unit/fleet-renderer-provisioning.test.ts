import { describe, expect, it, vi } from 'vitest'
import type { FleetBot } from '@maestrly/bot-fleet-protocol'
import type { MacInventory } from '../../src/shared/fleet-provisioning'
import type { FleetController } from '../../src/renderer/lib/fleet/use-fleet'
import {
  accountHost,
  emptyImportChoice,
  hasImportChoice,
  recommendedImportChoice,
  provisioningAvailability,
} from '../../src/renderer/lib/fleet/provisioning'

describe('fleet provisioning choices', () => {
  const inventory: MacInventory = {
    apiKeys: [
      { id: 'remote', name: 'Remote', kind: 'openai', host: 'api.example.test', localOnly: false },
      { id: 'local', name: 'Local', kind: 'openai', host: 'localhost', localOnly: true },
    ],
    copies: [{ id: 'cursor', kind: 'cursor', label: 'Cursor', expiresAt: null }],
    logins: [{ id: 'grok', kind: 'grok', label: 'Grok', email: null }],
    skills: [
      { name: 'ready', description: '', files: 1, bytes: 10, scripts: false, problem: null },
      { name: 'broken', description: '', files: 1, bytes: 10, scripts: false, problem: 'no-skill-md' },
    ],
    mcpServers: [
      { id: 'ready', name: 'Ready', transport: 'stdio', target: 'node', warnings: [], recommended: true },
      {
        id: 'local',
        name: 'Local',
        transport: 'http',
        target: 'localhost',
        warnings: ['local-url'],
        recommended: true,
      },
    ],
  }
  it('starts local-only, problematic and warned items unselected', () => {
    expect(recommendedImportChoice(inventory, ['accounts', 'skills', 'mcp'])).toEqual({
      apiKeyIds: ['remote'],
      copyIds: ['cursor'],
      loginIds: ['grok'],
      skillNames: ['ready'],
      mcpServerIds: ['ready'],
    })
  })
  it('never selects accounts or logins for the skills and MCP dialog', () => {
    expect(recommendedImportChoice(inventory, ['skills', 'mcp'])).toMatchObject({
      apiKeyIds: [],
      copyIds: [],
      loginIds: [],
    })
  })
  it('distinguishes an empty creation from a login-only creation', () => {
    expect(hasImportChoice(emptyImportChoice())).toBe(false)
    expect(hasImportChoice({ ...emptyImportChoice(), loginIds: ['grok'] })).toBe(true)
  })
  it('checks the server feature before bot capabilities', () => {
    const fleet = (features: string[]) => ({ state: { connection: { features } } }) as FleetController
    const bot = (lifecycle: FleetBot['lifecycle'], capabilities: string[]) => ({ lifecycle, capabilities }) as FleetBot
    expect(provisioningAvailability(fleet([]), bot('running', ['provisioning']))).toBe('update-server')
    expect(provisioningAvailability(fleet(['provisioning']), bot('running', []))).toBe('restart-bot')
    expect(provisioningAvailability(fleet(['provisioning']), bot('running', ['provisioning']))).toBe('ready')
    expect(provisioningAvailability(fleet(['provisioning']), bot('creating', []))).toBe('ready')
  })
  it('matches default provider hosts and preserves nondefault ports', () => {
    expect(accountHost('anthropic', null)).toBe('api.anthropic.com')
    expect(accountHost('openai-responses', null)).toBe('api.openai.com')
    expect(accountHost('openai', 'https://models.example.test:8080/v1')).toBe('models.example.test:8080')
  })
})

it('shares one pending login through Strict Mode effect replay', async () => {
  const { createLoginOwnership } = await import('../../src/renderer/lib/fleet/provisioning')
  const owner = createLoginOwnership()
  let resolve!: (value: { attempt: { loginId: string; state: 'pending' } }) => void
  const start = vi.fn(
    () =>
      new Promise<{ attempt: { loginId: string; state: 'pending' } }>((done) => {
        resolve = done
      })
  )
  const cancel = vi.fn(async () => {})
  const first = owner.acquire('opening', start, cancel)
  first.release()
  const second = owner.acquire('opening', start, cancel)
  resolve({ attempt: { loginId: 'one', state: 'pending' } })
  await second.result
  await Promise.resolve()
  expect(start).toHaveBeenCalledOnce()
  expect(cancel).not.toHaveBeenCalled()
  second.release()
  await Promise.resolve()
  await Promise.resolve()
  expect(cancel).toHaveBeenCalledExactlyOnceWith('one')
})

it('cancels a late login response after a real unmount', async () => {
  const { createLoginOwnership } = await import('../../src/renderer/lib/fleet/provisioning')
  const owner = createLoginOwnership()
  let resolve!: (value: { attempt: { loginId: string; state: 'pending' } }) => void
  const cancel = vi.fn(async () => {})
  const lease = owner.acquire(
    'opening',
    () =>
      new Promise<{ attempt: { loginId: string; state: 'pending' } }>((done) => {
        resolve = done
      }),
    cancel
  )
  lease.release()
  await Promise.resolve()
  resolve({ attempt: { loginId: 'late', state: 'pending' } })
  await lease.result
  await Promise.resolve()
  expect(cancel).toHaveBeenCalledExactlyOnceWith('late')
})

it('closes and invalidates polling before a rejected cancellation settles', async () => {
  const { closeBotLogin } = await import('../../src/renderer/lib/fleet/provisioning')
  let active = true
  const cancel = vi.fn(async () => {
    throw new Error('offline')
  })
  const close = vi.fn(() => {
    expect(active).toBe(false)
  })
  closeBotLogin(
    () => {
      active = false
    },
    cancel,
    close
  )
  expect(close).toHaveBeenCalledOnce()
  await Promise.resolve()
  expect(cancel).toHaveBeenCalledOnce()
})

it('settles a rejected import so selected sign-ins and Finish remain reachable', async () => {
  const { settleMacImport } = await import('../../src/renderer/lib/fleet/provisioning')
  const report = vi.fn()
  const error = vi.fn()
  const settled = vi.fn()
  await settleMacImport(
    async () => {
      throw new Error('offline')
    },
    report,
    error,
    settled
  )
  expect(report).not.toHaveBeenCalled()
  expect(error).toHaveBeenCalledWith('offline')
  expect(settled).toHaveBeenCalledOnce()
})

it('refreshes provisioning for account membership, connection and status changes only', async () => {
  const { botProvisioningKey } = await import('../../src/renderer/lib/fleet/provisioning')
  const bot = {
    accounts: {
      connected: true,
      providers: [
        { id: 'b', label: 'B' },
        { id: 'a', label: 'A' },
      ],
    },
    status: 'idle',
  } as FleetBot
  const key = botProvisioningKey(bot)
  expect(
    botProvisioningKey({ ...bot, accounts: { ...bot.accounts, providers: [...bot.accounts.providers].reverse() } })
  ).toBe(key)
  expect(botProvisioningKey({ ...bot, accounts: { ...bot.accounts, connected: false } })).not.toBe(key)
  expect(botProvisioningKey({ ...bot, accounts: { ...bot.accounts, providers: [] } })).not.toBe(key)
  expect(botProvisioningKey({ ...bot, status: 'working' } as FleetBot)).not.toBe(key)
})
