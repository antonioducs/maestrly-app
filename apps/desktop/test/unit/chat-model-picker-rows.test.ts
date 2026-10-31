import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatConfig } from '../../src/shared/chat'
import {
  cachedModelPickerRows,
  loadModelPickerRows,
  resetModelPickerRowsForTests,
  type ModelPickerRowsUpdate,
} from '../../src/renderer/components/chat/model-picker-rows'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const config = {
  providers: [
    { id: 'fast', name: 'Fast account', baseURL: '', apiKeyPresent: true },
    { id: 'slow', name: 'Slow account', baseURL: '', apiKeyPresent: true },
    { id: 'off', name: 'Signed out', baseURL: '', apiKeyPresent: false },
  ],
} as unknown as ChatConfig

const claudeAccount = (accountId: string, name: string) => ({
  id: 'builtin_claude_subscription@' + accountId,
  name,
  baseURL: '',
  apiKeyPresent: false,
  builtIn: true,
  connected: true,
  kind: 'claude-subscription',
  accountId,
})

/** A config whose Claude accounts form a pool, plus an API-key account that lists no models. */
const pooledConfig = (poolConnected = true) =>
  ({
    providers: [
      { id: 'keyed', name: 'Keyed account', baseURL: '', apiKeyPresent: true, connected: true, kind: 'openai' },
      claudeAccount('work', 'Work'),
      claudeAccount('home', 'Home'),
    ],
    subscriptionAccountPools: [
      {
        kind: 'claude-subscription',
        providerId: 'builtin_claude_subscription@~active',
        name: 'Claude (active account)',
        connected: poolConnected,
        memberProviderIds: ['builtin_claude_subscription@work', 'builtin_claude_subscription@home'],
        activeProviderId: 'builtin_claude_subscription@work',
        policy: 'drain',
        customMembers: false,
      },
    ],
  }) as unknown as ChatConfig

const summary = (update: ModelPickerRowsUpdate) => ({
  pending: update.pending,
  rows: update.rows.map((row) => `${row.providerName}:${row.modelId}`),
})

describe('model picker rows', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true })
    resetModelPickerRowsForTests()
  })
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage')
  })

  it('shows each account as soon as its list arrives, standing in its last list until then', async () => {
    localStorage.setItem(
      'chat.modelPicker.rows.v1:local',
      JSON.stringify([
        { providerId: 'slow', providerName: 'Renamed since', modelId: 'cached-model' },
        { providerId: 'off', providerName: 'Signed out', modelId: 'stale' },
        { providerId: 'fast', modelId: 'corrupt' },
      ])
    )
    const slow = deferred<string[]>()
    const updates: ModelPickerRowsUpdate[] = []
    const api = {
      chatConfig: async () => config,
      chatModels: (providerId: string) => (providerId === 'fast' ? Promise.resolve(['fast-model']) : slow.promise),
    }

    const loading = loadModelPickerRows(api as never, 'local', (update) => updates.push(update))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(updates.map(summary)).toEqual([
      { pending: 2, rows: ['Slow account:cached-model'] },
      { pending: 1, rows: ['Fast account:fast-model', 'Slow account:cached-model'] },
    ])
    slow.resolve(['slow-model'])
    await loading
    expect(summary(updates.at(-1)!)).toEqual({
      pending: 0,
      rows: ['Fast account:fast-model', 'Slow account:slow-model'],
    })

    // A restart reads the last complete list back from storage.
    resetModelPickerRowsForTests()
    expect(cachedModelPickerRows('local')?.map((row) => row.modelId)).toEqual(['fast-model', 'slow-model'])
  })

  it('drops the rows of an account that fails and lets a newer load silence an older one', async () => {
    const first = deferred<string[]>()
    const updates: Array<[string, ModelPickerRowsUpdate]> = []
    let calls = 0
    const api = {
      chatConfig: async () => config,
      chatModels: (providerId: string) => {
        if (providerId === 'slow') return Promise.reject(new Error('signed out'))
        calls += 1
        return calls === 1 ? first.promise : Promise.resolve(['newer'])
      },
    }

    const older = loadModelPickerRows(api as never, 'local', (update) => updates.push(['older', update]))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await loadModelPickerRows(api as never, 'local', (update) => updates.push(['newer', update]))
    first.resolve(['older'])
    await older

    expect(updates.filter(([load]) => load === 'older').every(([, update]) => update.pending > 0)).toBe(true)
    expect(summary(updates.at(-1)![1])).toEqual({ pending: 0, rows: ['Fast account:newer'] })
    expect(cachedModelPickerRows('local')?.map((row) => row.modelId)).toEqual(['newer'])
  })

  it('shows a failure line for an account whose key was refused instead of its stale rows', async () => {
    localStorage.setItem(
      'chat.modelPicker.rows.v1:local',
      JSON.stringify([{ providerId: 'slow', providerName: 'Slow account', modelId: 'cached-model' }])
    )
    const rejected = { outcome: 'rejected', status: 401, detail: 'Incorrect API key provided', checkedAt: 2 }
    // The key changed since the last list: the first config has no check yet, the listing then records the refusal.
    const configs = [
      config,
      {
        providers: config.providers.map((provider) =>
          provider.id === 'slow' ? { ...provider, keyCheck: rejected } : provider
        ),
      } as unknown as ChatConfig,
    ]
    let reads = 0
    const updates: ModelPickerRowsUpdate[] = []
    const api = {
      chatConfig: async () => configs[Math.min(reads++, configs.length - 1)],
      chatModels: async (providerId: string) => (providerId === 'fast' ? ['fast-model'] : []),
    }

    await loadModelPickerRows(api as never, 'local', (update) => updates.push(update))

    expect(reads).toBe(2)
    expect(updates[0].failures).toEqual([])
    const last = updates.at(-1)!
    expect(summary(last)).toEqual({ pending: 0, rows: ['Fast account:fast-model'] })
    expect(last.failures).toEqual([{ providerId: 'slow', providerName: 'Slow account', status: 401 }])

    // Once the config already knows, the stale rows never show, not even while the account answers.
    const pending = deferred<string[]>()
    const again: ModelPickerRowsUpdate[] = []
    const known = {
      chatConfig: async () => configs[1],
      chatModels: (providerId: string) => (providerId === 'fast' ? Promise.resolve(['fast-model']) : pending.promise),
    }
    const loading = loadModelPickerRows(known as never, 'local', (update) => again.push(update))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(again.every((update) => update.rows.every((row) => row.providerId !== 'slow'))).toBe(true)
    expect(again[0].failures.map((failure) => failure.providerId)).toEqual(['slow'])
    // A list arriving after all (the provider accepted the key on a later check) replaces the failure.
    pending.resolve(['slow-model'])
    await loading
    expect(again.at(-1)!.failures).toEqual([])
    expect(summary(again.at(-1)!).rows).toContain('Slow account:slow-model')
  })

  it('does not read the config again when every API-key account listed models', async () => {
    let reads = 0
    const api = {
      chatConfig: async () => {
        reads += 1
        return config
      },
      chatModels: async (providerId: string) => [`${providerId}-model`],
    }
    await loadModelPickerRows(api as never, 'local', () => {})
    expect(reads).toBe(1)
  })

  it('lists the active-account entry before the physical accounts, also once the config is read again', async () => {
    const asked: string[] = []
    let reads = 0
    const api = {
      chatConfig: async () => {
        reads += 1
        const current = pooledConfig()
        if (reads > 1) current.subscriptionAccountPools![0].name = 'Claude — Active account (Home)'
        return current
      },
      // The API-key account lists nothing, which makes the picker read the config again.
      chatModels: async (providerId: string) => {
        asked.push(providerId)
        return providerId === 'keyed' ? [] : ['sonnet']
      },
    }
    const updates: ModelPickerRowsUpdate[] = []

    await loadModelPickerRows(api as never, 'local', (update) => updates.push(update))

    expect(reads).toBe(2)
    expect(asked).toContain('builtin_claude_subscription@~active')
    const last = updates.at(-1)!
    expect(last.pending).toBe(0)
    expect(last.rows.map((row) => [row.providerId, row.modelId])).toEqual([
      ['builtin_claude_subscription@~active', 'sonnet'],
      ['builtin_claude_subscription@work', 'sonnet'],
      ['builtin_claude_subscription@home', 'sonnet'],
    ])
    expect(last.rows[0].providerName).toBe('Claude — Active account (Home)')
    expect(cachedModelPickerRows('local')?.map((row) => row.providerId)).toEqual(last.rows.map((row) => row.providerId))
  })

  it('does not ask for the models of a pool entry that is not connected', async () => {
    const asked: string[] = []
    const api = {
      chatConfig: async () => pooledConfig(false),
      chatModels: async (providerId: string) => {
        asked.push(providerId)
        return ['sonnet']
      },
    }
    const updates: ModelPickerRowsUpdate[] = []

    await loadModelPickerRows(api as never, 'local', (update) => updates.push(update))

    expect(asked).not.toContain('builtin_claude_subscription@~active')
    expect(updates.at(-1)!.rows.map((row) => row.providerId)).not.toContain('builtin_claude_subscription@~active')
  })
})
