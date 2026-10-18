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
})
