import { beforeEach, describe, expect, it, vi } from 'vitest'

const settings = new Map<string, string>()

vi.mock('../../src/main/store', () => ({
  getAppSetting: (key: string) => settings.get(key) ?? null,
  setAppSetting: (key: string, value: string) => {
    settings.set(key, value)
  },
}))

const BASE = 'builtin_codex_subscription'
const ACC_A = `${BASE}@acc_aaa`
const ACC_B = `${BASE}@acc_bbb`
const ACC_C = `${BASE}@acc_ccc`
const CLAUDE = 'builtin_claude_subscription'
const CLAUDE_ACC = `${CLAUDE}@acc_zzz`

let knownProviders: Array<{ id: string }> = [{ id: BASE }, { id: ACC_A }, { id: ACC_B }, { id: ACC_C }]

vi.mock('../../src/main/chat/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/chat/catalog')>()
  return {
    ...actual,
    listAvailableChatProviders: () => knownProviders as ReturnType<typeof actual.listAvailableChatProviders>,
  }
})

const {
  FAILOVER_CONFIG_KEY,
  emptyFailoverConfig,
  sanitizeFailoverConfig,
  listFailoverRoutes,
  getFailoverRoute,
  setFailoverRoute,
  removeAccountFromFailoverConfig,
  freezeFailoverChain,
} = await import('../../src/main/chat/subscription-failover/config')

beforeEach(() => {
  settings.clear()
  knownProviders = [{ id: BASE }, { id: ACC_A }, { id: ACC_B }, { id: ACC_C }]
})

describe('subscription failover config', () => {
  it('emptyFailoverConfig returns version 1 with no routes', () => {
    expect(emptyFailoverConfig()).toEqual({ version: 1, routes: [] })
  })

  it('sanitize drops corrupted / wrong-version / non-object payloads', () => {
    const known = new Set([BASE, ACC_A])
    expect(sanitizeFailoverConfig(null, known)).toEqual(emptyFailoverConfig())
    expect(sanitizeFailoverConfig('{broken', known)).toEqual(emptyFailoverConfig())
    expect(sanitizeFailoverConfig({ version: 2, routes: [] }, known)).toEqual(emptyFailoverConfig())
    expect(sanitizeFailoverConfig({ version: 1, routes: 'nope' }, known)).toEqual(emptyFailoverConfig())
  })

  it('sanitize keeps only known Codex primaries and normalizes fallbacks', () => {
    const known = new Set([BASE, ACC_A, ACC_B])
    const sanitized = sanitizeFailoverConfig(
      {
        version: 1,
        routes: [
          {
            primaryProviderId: ACC_A,
            enabled: true,
            fallbackProviderIds: [ACC_B, ACC_B, ACC_A, ACC_C, CLAUDE_ACC, '  ', 12, ACC_B],
          },
          {
            primaryProviderId: 'prov_byok',
            enabled: true,
            fallbackProviderIds: [ACC_A],
          },
          {
            primaryProviderId: CLAUDE,
            enabled: true,
            fallbackProviderIds: [CLAUDE_ACC],
          },
          {
            primaryProviderId: ACC_C,
            enabled: 1,
            fallbackProviderIds: [ACC_A],
          },
          null,
          'x',
        ],
      },
      known
    )
    expect(sanitized).toEqual({
      version: 1,
      routes: [
        {
          primaryProviderId: ACC_A,
          enabled: true,
          // dedupe, drop self, drop other-base, keep disconnected same-base ACC_C
          fallbackProviderIds: [ACC_B, ACC_C],
        },
      ],
    })
  })

  it('sanitize with empty known set still accepts valid-looking Codex primaries', () => {
    const sanitized = sanitizeFailoverConfig(
      {
        version: 1,
        routes: [{ primaryProviderId: ACC_A, enabled: false, fallbackProviderIds: [ACC_B] }],
      },
      new Set()
    )
    expect(sanitized.routes).toEqual([{ primaryProviderId: ACC_A, enabled: false, fallbackProviderIds: [ACC_B] }])
  })

  it('setFailoverRoute normalizes, persists, and upserts', () => {
    const first = setFailoverRoute({
      primaryProviderId: ` ${ACC_A} `,
      enabled: true,
      fallbackProviderIds: [ACC_B, ACC_B, ACC_A, CLAUDE_ACC, ACC_C],
    })
    expect(first).toEqual({
      primaryProviderId: ACC_A,
      enabled: true,
      fallbackProviderIds: [ACC_B, ACC_C],
    })
    expect(JSON.parse(settings.get(FAILOVER_CONFIG_KEY)!)).toMatchObject({
      version: 1,
      routes: [first],
    })

    const second = setFailoverRoute({
      primaryProviderId: ACC_A,
      enabled: false,
      fallbackProviderIds: [],
    })
    expect(second).toEqual({ primaryProviderId: ACC_A, enabled: false, fallbackProviderIds: [] })
    expect(listFailoverRoutes()).toEqual([second])
  })

  it('setFailoverRoute rejects unsupported primary', () => {
    expect(() =>
      setFailoverRoute({
        primaryProviderId: 'builtin_grok_subscription',
        enabled: true,
        fallbackProviderIds: [CLAUDE_ACC],
      })
    ).toThrow(/Codex/)
    expect(settings.has(FAILOVER_CONFIG_KEY)).toBe(false)
  })

  it('setFailoverRoute allows disconnected same-base fallbacks', () => {
    knownProviders = [{ id: BASE }, { id: ACC_A }]
    const route = setFailoverRoute({
      primaryProviderId: ACC_A,
      enabled: true,
      fallbackProviderIds: [ACC_B],
    })
    expect(route.fallbackProviderIds).toEqual([ACC_B])
    expect(getFailoverRoute(ACC_A)?.fallbackProviderIds).toEqual([ACC_B])
  })

  it('freezeFailoverChain does not recurse and ignores disabled / empty fallbacks', () => {
    setFailoverRoute({
      primaryProviderId: ACC_A,
      enabled: true,
      fallbackProviderIds: [ACC_B],
    })
    setFailoverRoute({
      primaryProviderId: ACC_B,
      enabled: true,
      fallbackProviderIds: [ACC_C],
    })
    expect(freezeFailoverChain(ACC_A)).toEqual([ACC_A, ACC_B])

    setFailoverRoute({
      primaryProviderId: ACC_A,
      enabled: false,
      fallbackProviderIds: [ACC_B],
    })
    expect(freezeFailoverChain(ACC_A)).toEqual([ACC_A])

    setFailoverRoute({
      primaryProviderId: ACC_A,
      enabled: true,
      fallbackProviderIds: [],
    })
    expect(freezeFailoverChain(ACC_A)).toEqual([ACC_A])

    expect(freezeFailoverChain(ACC_C)).toEqual([ACC_C])
  })

  it('removeAccountFromFailoverConfig clears primary routes and fallback refs', () => {
    setFailoverRoute({
      primaryProviderId: ACC_A,
      enabled: true,
      fallbackProviderIds: [ACC_B, ACC_C],
    })
    setFailoverRoute({
      primaryProviderId: ACC_B,
      enabled: true,
      fallbackProviderIds: [ACC_A, ACC_C],
    })

    removeAccountFromFailoverConfig(ACC_A)
    expect(listFailoverRoutes()).toEqual([{ primaryProviderId: ACC_B, enabled: true, fallbackProviderIds: [ACC_C] }])

    removeAccountFromFailoverConfig('acc_bbb')
    expect(listFailoverRoutes()).toEqual([])
  })

  it('listFailoverRoutes sanitizes corrupted persisted JSON', () => {
    settings.set(FAILOVER_CONFIG_KEY, '{broken')
    expect(listFailoverRoutes()).toEqual([])

    settings.set(
      FAILOVER_CONFIG_KEY,
      JSON.stringify({
        version: 1,
        routes: [
          { primaryProviderId: ACC_A, enabled: true, fallbackProviderIds: [ACC_B] },
          { primaryProviderId: 'not-a-provider', enabled: true, fallbackProviderIds: [] },
        ],
      })
    )
    expect(listFailoverRoutes()).toEqual([{ primaryProviderId: ACC_A, enabled: true, fallbackProviderIds: [ACC_B] }])
  })
})

describe('Claude routes', () => {
  it('preserves Codex v1 routes and freezes same-family Claude fallbacks without recursion', () => {
    knownProviders.push({ id: CLAUDE }, { id: CLAUDE_ACC })
    const next = `${CLAUDE}@acc_next`
    setFailoverRoute({ primaryProviderId: BASE, enabled: true, fallbackProviderIds: [ACC_A] })
    setFailoverRoute({
      primaryProviderId: CLAUDE,
      enabled: true,
      fallbackProviderIds: [CLAUDE_ACC, BASE, CLAUDE_ACC, CLAUDE],
    })
    setFailoverRoute({ primaryProviderId: CLAUDE_ACC, enabled: true, fallbackProviderIds: [next] })
    expect(freezeFailoverChain(BASE)).toEqual([BASE, ACC_A])
    expect(freezeFailoverChain(CLAUDE)).toEqual([CLAUDE, CLAUDE_ACC])
    removeAccountFromFailoverConfig(CLAUDE_ACC)
    expect(freezeFailoverChain(CLAUDE)).toEqual([CLAUDE])
    expect(freezeFailoverChain(BASE)).toEqual([BASE, ACC_A])
  })
})

it('removes provider-scoped account references only from their own family', () => {
  const codex = `${BASE}@acc_shared`
  const claude = `${CLAUDE}@acc_shared`
  setFailoverRoute({ primaryProviderId: BASE, enabled: true, fallbackProviderIds: [codex] })
  setFailoverRoute({ primaryProviderId: CLAUDE, enabled: true, fallbackProviderIds: [claude] })
  removeAccountFromFailoverConfig(claude)
  expect(freezeFailoverChain(BASE)).toEqual([BASE, codex])
  expect(freezeFailoverChain(CLAUDE)).toEqual([CLAUDE])
})
