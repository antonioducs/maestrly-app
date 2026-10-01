import { describe, expect, it, vi } from 'vitest'
import type { FleetBot, FleetEnvironment } from '@maestrly/bot-fleet-protocol'
import type { MacInventory } from '../../src/shared/fleet-provisioning'
import type { FleetController } from '../../src/renderer/lib/fleet/use-fleet'
import {
  accountHost,
  emptyImportChoice,
  environmentJoinAvailability,
  environmentJoinHint,
  environmentScreenAvailability,
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
    logins: [
      { id: 'grok', kind: 'grok', label: 'Grok', email: null },
      { id: 'google', kind: 'antigravity', label: 'Google AI', email: null },
    ],
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
      loginIds: ['grok', 'google'],
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
  it('lets a bot join only a running environment whose Maestrly hosts several bots', () => {
    const fleet = (features: string[]) => ({ state: { connection: { features } } }) as FleetController
    const connected = fleet(['provisioning', 'environments'])
    const environment = (patch: Partial<FleetEnvironment> = {}) =>
      ({
        lifecycle: 'running',
        capabilities: ['provisioning', 'environments'],
        botIds: ['scout'],
        ...patch,
      }) as FleetEnvironment
    expect(environmentJoinAvailability(connected, environment())).toBe('ready')
    expect(environmentJoinAvailability(fleet(['provisioning']), environment())).toBe('update-server')
    // A stopped environment installs a new bot only once started: the create dialog would wait at its profile.
    expect(environmentJoinAvailability(connected, environment({ lifecycle: 'stopped' }))).toBe('start-environment')
    expect(environmentJoinAvailability(connected, environment({ lifecycle: 'failed' }))).toBe('start-environment')
    for (const lifecycle of ['creating', 'starting', 'restarting', 'stopping'] as const)
      expect(environmentJoinAvailability(connected, environment({ lifecycle })), lifecycle).toBe('not-running')
    // A bot migrated to its own environment runs its old image until restarted.
    expect(environmentJoinAvailability(connected, environment({ capabilities: ['provisioning'] }))).toBe(
      'restart-environment'
    )
    const full = environment({ botIds: Array.from({ length: 8 }, (_, index) => `bot-${index}`) })
    expect(environmentJoinAvailability(connected, full)).toBe('full')
    expect(environmentJoinHint('start-environment')).toEqual({ key: 'environment.startToJoin' })
    expect(environmentJoinHint('not-running')).toEqual({ key: 'environment.waitToJoin' })
    expect(environmentJoinHint('restart-environment')).toEqual({ key: 'environment.restartToJoin' })
    expect(environmentJoinHint('full')).toEqual({ key: 'environment.full', values: { max: 8 } })
    expect(environmentJoinHint('update-server')).toEqual({ key: 'provisioning.updateServer' })
  })
  it('keeps an environment on an image from before environments to its bot browser until it restarts', () => {
    // What a migrated environment advertises after the gateway update, before its restart.
    expect(environmentScreenAvailability({ lifecycle: 'running', capabilities: ['provisioning'] })).toBe(
      'restart-environment'
    )
    expect(environmentScreenAvailability({ lifecycle: 'running', capabilities: [] })).toBe('restart-environment')
    expect(
      environmentScreenAvailability({ lifecycle: 'running', capabilities: ['provisioning', 'environments'] })
    ).toBe('ready')
    // A stopped environment shows no screen at all; it is not told to restart.
    expect(environmentScreenAvailability({ lifecycle: 'stopped', capabilities: ['provisioning'] })).toBe('ready')
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

it('translates local provisioning codes and keeps unknown provider errors', async () => {
  const { provisioningErrorText } = await import('../../src/renderer/lib/fleet/provisioning')
  const en = (await import('../../src/shared/i18n/en/fleet')).default
  const pt = (await import('../../src/shared/i18n/pt-BR/fleet')).default
  const translate = (catalog: typeof en | typeof pt) => (key: string) => {
    const code = key.replace('provisioning.error.', '') as keyof typeof en.provisioning.error
    return catalog.provisioning.error[code]
  }
  expect(Object.keys(en.provisioning.error)).toEqual(Object.keys(pt.provisioning.error))
  for (const code of Object.keys(en.provisioning.error)) {
    expect(provisioningErrorText('raw', translate(pt), code)).toBe(translate(pt)('provisioning.error.' + code))
    expect(provisioningErrorText('raw', translate(en), code)).toBe(translate(en)('provisioning.error.' + code))
  }
  expect(provisioningErrorText('[fleet:login-page-unavailable] unavailable', translate(pt))).toBe(
    pt.provisioning.error['login-page-unavailable']
  )
  expect(provisioningErrorText('Provider rejected this account', translate(pt))).toBe('Provider rejected this account')
  expect(provisioningErrorText('Future error', translate(pt), 'future-code')).toBe('Future error')
})
