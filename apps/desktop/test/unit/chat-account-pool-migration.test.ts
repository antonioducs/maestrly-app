import { beforeEach, describe, expect, it, vi } from 'vitest'

const settings = new Map<string, string>()
const conversations = new Map<string, string>()

vi.mock('../../src/main/store', () => ({
  getAppSetting: (key: string) => settings.get(key) ?? null,
  setAppSetting: (key: string, value: string) => void settings.set(key, value),
  getDb: () => ({
    prepare: (sql: string) => ({
      all: (pattern?: string) => {
        if (sql.startsWith('SELECT id, ui_prefs FROM conversations'))
          return [...conversations].map(([id, ui_prefs]) => ({ id, ui_prefs }))
        if (sql.startsWith('SELECT ui_prefs FROM conversations'))
          return [...conversations.values()].map((ui_prefs) => ({ ui_prefs }))
        if (sql.startsWith('SELECT value FROM app_settings')) {
          const prefix = pattern!.replace(/%$/, '')
          return [...settings]
            .filter(([key]) => key.startsWith(prefix) && key.endsWith('.profile'))
            .map(([, value]) => ({ value }))
        }
        throw new Error(`unexpected query: ${sql}`)
      },
      run: (value: string, id: string) => void conversations.set(id, value),
    }),
  }),
}))
vi.mock('../../src/main/chat/diag-log', () => ({ chatDiag: () => {} }))

const CODEX = 'builtin_codex_subscription'
const CODEX_A = `${CODEX}@acc_aaa`
const CODEX_B = `${CODEX}@acc_bbb`
const CLAUDE = 'builtin_claude_subscription'
const CLAUDE_A = `${CLAUDE}@acc_aaa`
const CLAUDE_B = `${CLAUDE}@acc_bbb`

let providers: Array<{ id: string }> = []
vi.mock('../../src/main/chat/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/chat/catalog')>()
  return { ...actual, listAvailableChatProviders: () => providers as never }
})

const { FAILOVER_CONFIG_KEY, freezeFailoverChain, readLegacyFailoverRoutes } = await import(
  '../../src/main/chat/subscription-failover/config'
)
const { migrateFailoverRoutesToAccountPools, routeForKind } = await import(
  '../../src/main/chat/subscription-failover/migrate-routes'
)
const { ACCOUNT_POOLS_CONFIG_KEY, getAccountPool } = await import(
  '../../src/main/chat/subscription-failover/account-pool'
)

const saveRoutes = (routes: unknown[]) => settings.set(FAILOVER_CONFIG_KEY, JSON.stringify({ version: 1, routes }))
const route = (primaryProviderId: string, fallbackProviderIds: string[], enabled = true) => ({
  primaryProviderId,
  enabled,
  fallbackProviderIds,
})
const botProfile = (botId: string, selection: { providerId: string; modelId: string } | null) =>
  settings.set(`fleet.instance.bots.${botId}.profile`, JSON.stringify({ profile: { botId, selection } }))

beforeEach(() => {
  settings.clear()
  conversations.clear()
  providers = [{ id: CODEX }, { id: CODEX_A }, { id: CODEX_B }, { id: CLAUDE }, { id: CLAUDE_A }, { id: CLAUDE_B }]
})

describe('legacy failover routes', () => {
  it('reads only the routes that were on and had somewhere to go', () => {
    expect(readLegacyFailoverRoutes()).toEqual([])
    settings.set(FAILOVER_CONFIG_KEY, '{broken')
    expect(readLegacyFailoverRoutes()).toEqual([])
    saveRoutes([
      route(CODEX_A, [CODEX_B, CODEX_B, CODEX_A, ' ', 12 as never, 'prov_byok']),
      route(CODEX_B, [CODEX_A], false),
      route(CLAUDE, []),
      route('builtin_grok_subscription', [CODEX_A]),
      route(CODEX_A, [CODEX]),
      null,
    ])
    expect(readLegacyFailoverRoutes()).toEqual([{ primaryProviderId: CODEX_A, fallbackProviderIds: [CODEX_B] }])
  })

  it('freezes an account alone and the active account on its pool', () => {
    expect(freezeFailoverChain(CODEX_A)).toEqual([CODEX_A])
    expect(freezeFailoverChain(' ')).toEqual([])
    settings.set(
      ACCOUNT_POOLS_CONFIG_KEY,
      JSON.stringify({ version: 1, pools: [{ kind: 'codex-subscription', activeProviderId: CODEX_A }] })
    )
    expect(freezeFailoverChain(`${CODEX}@~active`)).toEqual([CODEX_A, CODEX_B, CODEX])
  })
})

describe('routes into account pools', () => {
  it('turns a route into its provider pool, its primary preferred, and moves the choices made on it', () => {
    saveRoutes([route(CODEX_A, [CODEX_B, CLAUDE_A])])
    settings.set('chat.defaultProvider', CODEX_A)
    settings.set('chat.lastSelection', JSON.stringify({ providerId: CODEX_A, modelId: 'gpt' }))
    settings.set('chat.imageInterpreter', JSON.stringify({ providerId: CODEX_B, modelId: 'gpt' }))
    conversations.set('c1', JSON.stringify({ chat: { providerId: CODEX_A, modelId: 'gpt' }, other: { providerId: CODEX_A } }))
    conversations.set('c2', JSON.stringify({ chat: { providerId: CODEX_B, modelId: 'gpt' } }))
    botProfile('bot_1', { providerId: CODEX_A, modelId: 'gpt' })

    expect(migrateFailoverRoutesToAccountPools()).toEqual([{ kind: 'codex-subscription', primaryProviderId: CODEX_A }])
    expect(getAccountPool('codex-subscription')).toMatchObject({
      memberProviderIds: [CODEX_A, CODEX_B],
      activeProviderId: CODEX_A,
      policy: 'prefer-active',
      enabled: true,
      autoJoin: false,
    })
    const active = `${CODEX}@~active`
    expect(settings.get('chat.defaultProvider')).toBe(active)
    expect(JSON.parse(settings.get('chat.lastSelection')!)).toEqual({ providerId: active, modelId: 'gpt' })
    expect(JSON.parse(settings.get('chat.imageInterpreter')!).providerId).toBe(CODEX_B)
    expect(JSON.parse(conversations.get('c1')!)).toEqual({
      chat: { providerId: active, modelId: 'gpt' },
      other: { providerId: CODEX_A },
    })
    expect(JSON.parse(conversations.get('c2')!).chat.providerId).toBe(CODEX_B)
    // A bot's choice belongs to the bot server: the bot stays on the account it chose.
    expect(JSON.parse(settings.get('fleet.instance.bots.bot_1.profile')!).profile.selection.providerId).toBe(CODEX_A)
    expect(readLegacyFailoverRoutes()).toEqual([])
    expect(migrateFailoverRoutesToAccountPools()).toEqual([])
  })

  it('leaves a provider whose pool was already set up, and routes left with one account', () => {
    settings.set(
      ACCOUNT_POOLS_CONFIG_KEY,
      JSON.stringify({ version: 1, pools: [{ kind: 'codex-subscription', policy: 'drain' }] })
    )
    saveRoutes([route(CODEX_A, [CODEX_B]), route(CLAUDE_A, [`${CLAUDE}@acc_gone`])])
    expect(migrateFailoverRoutesToAccountPools()).toEqual([])
    expect(getAccountPool('codex-subscription')).toMatchObject({ policy: 'drain', activeProviderId: CODEX })
    expect(getAccountPool('claude-subscription').customMembers).toBe(false)
    expect(readLegacyFailoverRoutes()).toEqual([])
  })

  it('keeps each provider apart', () => {
    saveRoutes([route(CODEX_B, [CODEX_A]), route(CLAUDE_B, [CLAUDE])])
    expect(migrateFailoverRoutesToAccountPools()).toEqual([
      { kind: 'claude-subscription', primaryProviderId: CLAUDE_B },
      { kind: 'codex-subscription', primaryProviderId: CODEX_B },
    ])
    expect(getAccountPool('claude-subscription').memberProviderIds).toEqual([CLAUDE_B, CLAUDE])
    expect(getAccountPool('codex-subscription').memberProviderIds).toEqual([CODEX_B, CODEX_A])
  })

  it('takes the route of the account the most bots and choices run on', () => {
    saveRoutes([route(CLAUDE, [CLAUDE_A, CLAUDE_B]), route(CLAUDE_A, [CLAUDE])])
    settings.set('chat.defaultProvider', CLAUDE)
    botProfile('bot_1', { providerId: CLAUDE_A, modelId: 'opus' })
    botProfile('bot_2', { providerId: CLAUDE_A, modelId: 'opus' })
    botProfile('bot_3', null)
    expect(migrateFailoverRoutesToAccountPools()).toEqual([
      { kind: 'claude-subscription', primaryProviderId: CLAUDE_A },
    ])
    expect(getAccountPool('claude-subscription').memberProviderIds).toEqual([CLAUDE_A, CLAUDE])
  })
})

describe('route choice', () => {
  const a = { primaryProviderId: CLAUDE_A, fallbackProviderIds: [CLAUDE] }
  const b = { primaryProviderId: CLAUDE_B, fallbackProviderIds: [CLAUDE, CLAUDE_A] }
  it('prefers usage, then the default account, then the longest route', () => {
    expect(routeForKind([], null, new Map())).toBeNull()
    expect(routeForKind([a, b], null, new Map([[CLAUDE_A, 2]]))).toBe(a)
    expect(routeForKind([a, b], CLAUDE_A, new Map())).toBe(a)
    expect(routeForKind([a, b], null, new Map())).toBe(b)
    expect(routeForKind([b, a], null, new Map([[CLAUDE_A, 1], [CLAUDE_B, 1]]))).toBe(b)
  })
})
