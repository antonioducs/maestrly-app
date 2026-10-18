import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  discovery: vi.fn<() => Promise<string[]>>(),
  disk: new Map<string, string>(),
}))

vi.mock('../../src/main/store', () => ({
  getAppSetting: (key: string) => state.disk.get(key) ?? null,
  setAppSetting: (key: string, value: string) => state.disk.set(key, value),
}))

vi.mock('../../src/main/chat/model-meta', () => ({
  listCatalogProviderModelIds: state.discovery,
}))

import {
  claudeModelPickerSnapshot,
  listClaudeRemoteCatalog,
  onClaudeRemoteCatalogChanged,
  resetClaudeRemoteCatalogForTests,
  sanitizeClaudeRemoteCatalog,
} from '../../src/main/chat/claude-agent-sdk/model-catalog'
import { ClaudeSubscriptionManager } from '../../src/main/chat/claude-agent-sdk/manager'

beforeEach(() => {
  state.discovery.mockReset().mockResolvedValue([])
  state.disk.clear()
  resetClaudeRemoteCatalogForTests()
})

describe('Claude remote model catalog', () => {
  it('sanitizes families, duplicates and malicious ids', () => {
    const models = sanitizeClaudeRemoteCatalog([
      { id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1' },
      { id: 'CLAUDE-FABLE-5-1', display_name: 'duplicate' },
      { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
      { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' },
      { id: '../../escape' },
      { id: 'claude-mythos-5-1' },
    ])
    expect(models.map((model) => model.id)).toEqual(['claude-fable-5-1', 'claude-opus-4-6', 'claude-opus-4-8'])
    expect(models[0]?.behavesAs).toBe('claude-fable-5')
  })

  it('discovers public Anthropic models and exposes sanitized picker rows', async () => {
    state.discovery.mockResolvedValue([
      'claude-fable-5-1',
      'claude-opus-4-8',
      'claude-opus-4-6',
      'claude-opus-4-1-20250805',
      'bad/id',
      'claude-mythos-5-1',
    ])
    const models = await listClaudeRemoteCatalog(true)
    expect(state.discovery).toHaveBeenCalledWith('anthropic')
    expect(models.map((model) => model.id)).toEqual(['claude-fable-5-1', 'claude-opus-4-6', 'claude-opus-4-8'])
    expect(claudeModelPickerSnapshot()).toMatchObject({
      replaceBuiltInOptions: false,
      options: expect.arrayContaining([
        expect.objectContaining({ model: 'claude-fable-5-1', behavesAs: 'claude-fable-5' }),
        expect.objectContaining({ model: 'claude-opus-4-8', behavesAs: 'claude-opus-4-6' }),
      ]),
    })
    expect(JSON.parse(state.disk.get('chat.claude.modelCatalog')!)).toMatchObject({ source: 'models.dev' })
  })

  it('serves a fresh persisted cache without public discovery and preserves it offline', async () => {
    state.discovery.mockResolvedValue(['claude-opus-4-8'])
    await listClaudeRemoteCatalog(true)
    resetClaudeRemoteCatalogForTests()
    state.discovery.mockClear().mockRejectedValue(new Error('offline'))
    expect((await listClaudeRemoteCatalog()).map((model) => model.id)).toEqual(['claude-opus-4-8'])
    expect(state.discovery).not.toHaveBeenCalled()
    expect((await listClaudeRemoteCatalog(true)).map((model) => model.id)).toEqual(['claude-opus-4-8'])
    expect(state.discovery).toHaveBeenCalledOnce()
    expect(JSON.parse(state.disk.get('chat.claude.modelCatalog')!).source).toBe('models.dev')
  })

  it('returns stale persisted models immediately while refreshing them in the background', async () => {
    state.discovery.mockResolvedValue(['claude-opus-4-6'])
    await listClaudeRemoteCatalog(true)
    const persisted = JSON.parse(state.disk.get('chat.claude.modelCatalog')!)
    persisted.at = Date.now() - 16 * 60 * 1000
    state.disk.set('chat.claude.modelCatalog', JSON.stringify(persisted))
    resetClaudeRemoteCatalogForTests()
    let resolve!: (ids: string[]) => void
    state.discovery.mockReset().mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )

    expect((await listClaudeRemoteCatalog()).map((model) => model.id)).toEqual(['claude-opus-4-6'])
    expect(state.discovery).toHaveBeenCalledOnce()
    const refreshed = listClaudeRemoteCatalog(true)
    resolve(['claude-opus-4-8'])
    expect((await refreshed).map((model) => model.id)).toEqual(['claude-opus-4-8'])
    expect(state.discovery).toHaveBeenCalledOnce()
    expect(JSON.parse(state.disk.get('chat.claude.modelCatalog')!).models[0].id).toBe('claude-opus-4-8')
  })

  it.each(['empty', 'offline'])('uses bundled families on the first %s discovery', async (mode) => {
    if (mode === 'offline') state.discovery.mockRejectedValue(new Error('offline'))
    expect((await listClaudeRemoteCatalog()).map((model) => model.id)).toEqual([
      'claude-fable-5',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
    ])
    expect(JSON.parse(state.disk.get('chat.claude.modelCatalog')!).source).toBe('bundled')
  })

  it('deduplicates concurrent discovery and returns detached cached models', async () => {
    let resolve!: (ids: string[]) => void
    state.discovery.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const first = listClaudeRemoteCatalog(true)
    const second = listClaudeRemoteCatalog(true)
    resolve(['claude-opus-4-8'])
    expect(await first).toEqual(await second)
    expect(state.discovery).toHaveBeenCalledOnce()
    const cached = await listClaudeRemoteCatalog()
    cached[0]!.capabilities.push('effort')
    cached[0]!.label = 'mutated'
    expect((await listClaudeRemoteCatalog())[0]).toMatchObject({ label: 'Opus 4 8', capabilities: [] })
  })

  it('notifies only when a forced refresh changes the catalog', async () => {
    const listener = vi.fn()
    const unsubscribe = onClaudeRemoteCatalogChanged(listener)
    state.discovery.mockResolvedValue(['claude-opus-4-8'])
    await listClaudeRemoteCatalog(true)
    await listClaudeRemoteCatalog(true)
    expect(listener).toHaveBeenCalledTimes(1)
    state.discovery.mockResolvedValue(['claude-opus-4-8', 'claude-opus-4-6'])
    await listClaudeRemoteCatalog(true)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    state.discovery.mockResolvedValue(['claude-fable-5-1'])
    await listClaudeRemoteCatalog(true)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('injects the same picker into every account while preserving inline settings', async () => {
    state.discovery.mockResolvedValue(['claude-fable-5-1'])
    await listClaudeRemoteCatalog(true)
    const queryFactory = vi.fn(() => ({ close: vi.fn() }))
    const managers = ['account-a', 'account-b'].map(
      (accountId) =>
        new ClaudeSubscriptionManager({
          accountId,
          getUserDataPath: () => '/tmp/maestrly',
          getProcessEnvironment: () => ({ HOME: '/home/test', PATH: '/bin' }),
          resolveExecutable: () => '/bin/claude',
          queryFactory: queryFactory as never,
        })
    )

    for (const manager of managers) {
      manager.createQuery({ prompt: '', options: { settings: { fastMode: true } } }).close()
    }

    expect(queryFactory).toHaveBeenCalledTimes(2)
    for (const [params] of queryFactory.mock.calls as unknown as Array<
      [{ options: { settings: Record<string, unknown> } }]
    >) {
      expect(params.options.settings).toMatchObject({
        fastMode: true,
        modelPicker: {
          options: [expect.objectContaining({ model: 'claude-fable-5-1', behavesAs: 'claude-fable-5' })],
        },
      })
    }
    for (const manager of managers) manager.dispose()
  })
})
