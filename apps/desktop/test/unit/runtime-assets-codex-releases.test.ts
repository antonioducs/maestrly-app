import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_MAX_DOWNLOAD_BYTES,
  CodexReleaseDiscoveryError,
  codexDownloadCeiling,
  compareStableVersions,
  discoverCodexRelease,
} from '../../src/main/runtime-assets/codex-releases'
import {
  CodexReleaseMetadataUnavailableError,
  CodexReleaseStore,
  type CodexReleaseStorage,
} from '../../src/main/runtime-assets/codex-release-store'
import { RUNTIME_ASSET_REGISTRY, type RuntimeAssetDefinition } from '../../src/main/runtime-assets/registry'

const INTEGRITY = `sha512-${'Q'.repeat(86)}==`
const LATEST_URL = 'https://registry.npmjs.org/@openai/codex/latest'

function latestDocument(version = '0.156.0', overrides: Record<string, unknown> = {}) {
  return {
    name: '@openai/codex',
    version,
    optionalDependencies: {
      '@openai/codex-darwin-arm64': `npm:@openai/codex@${version}-darwin-arm64`,
      '@openai/codex-linux-x64': `npm:@openai/codex@${version}-linux-x64`,
    },
    dist: { tarball: `https://registry.npmjs.org/@openai/codex/-/codex-${version}.tgz`, integrity: INTEGRITY },
    ...overrides,
  }
}

function platformDocument(version = '0.156.0', dist: Record<string, unknown> = {}, overrides = {}) {
  return {
    name: '@openai/codex',
    version: `${version}-darwin-arm64`,
    os: ['darwin'],
    cpu: ['arm64'],
    dist: {
      tarball: `https://registry.npmjs.org/@openai/codex/-/codex-${version}-darwin-arm64.tgz`,
      integrity: INTEGRITY,
      unpackedSize: 326_229_438,
      fileCount: 44,
      ...dist,
    },
    ...overrides,
  }
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

function registryFetch(routes: Record<string, () => Response | Promise<Response>>) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    const route = routes[url]
    if (!route) return new Response('not found', { status: 404 })
    return route()
  })
}

function standardRoutes(version = '0.156.0') {
  return {
    [LATEST_URL]: () => json(latestDocument(version)),
    [`https://registry.npmjs.org/@openai/codex/${version}-darwin-arm64`]: () => json(platformDocument(version)),
  }
}

describe('discoverCodexRelease', () => {
  it('builds a verified single-target definition from the latest stable release', async () => {
    const fetchImpl = registryFetch(standardRoutes())
    const definition = await discoverCodexRelease('mac-arm64', undefined, { fetch: fetchImpl })

    expect(definition).toMatchObject({ id: 'codex-runtime', version: '0.156.0' })
    expect(Object.keys(definition.targets)).toEqual(['mac-arm64'])
    expect(definition.targets['mac-arm64']).toMatchObject({
      url: 'https://registry.npmjs.org/@openai/codex/-/codex-0.156.0-darwin-arm64.tgz',
      archive: 'tar.gz',
      hash: { algorithm: 'sha512', encoding: 'base64', digest: `${'Q'.repeat(86)}==` },
      unpackedBytes: 326_229_438,
      maxDownloadBytes: codexDownloadCeiling(326_229_438, 44),
      stripPrefix: 'package/vendor/aarch64-apple-darwin',
      criticalPaths: ['bin/codex', 'codex-package.json'],
      executablePath: 'bin/codex',
    })
    const target = definition.targets['mac-arm64']!
    expect(target.downloadBytes).toBeLessThan(target.maxDownloadBytes)
    expect(target.maxDownloadBytes).toBeGreaterThanOrEqual(target.unpackedBytes)
    // Only two small version documents: never the full packument.
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      LATEST_URL,
      'https://registry.npmjs.org/@openai/codex/0.156.0-darwin-arm64',
    ])
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'manual' })
  })

  it('reports the same or an older version unchanged; the caller decides whether it is newer', async () => {
    const definition = await discoverCodexRelease('mac-arm64', undefined, {
      fetch: registryFetch(standardRoutes('0.150.0')),
    })
    expect(definition.version).toBe('0.150.0')
    expect(compareStableVersions(definition.version, RUNTIME_ASSET_REGISTRY['codex-runtime'].version)).toBe(-1)
    expect(compareStableVersions('0.155.1', '0.155.1')).toBe(0)
    expect(compareStableVersions('0.156.0', '0.155.10')).toBe(1)
    expect(compareStableVersions('0.156.0-alpha.1', '0.155.1')).toBeNull()
  })

  it.each([
    ['a prerelease', { [LATEST_URL]: () => json(latestDocument('0.157.0-alpha.2')) }, /not a stable version/],
    [
      'another package',
      { [LATEST_URL]: () => json(latestDocument('0.156.0', { name: '@evil/codex' })) },
      /does not describe/,
    ],
    [
      'a missing platform',
      { [LATEST_URL]: () => json(latestDocument('0.156.0', { optionalDependencies: {} })) },
      /coherent @openai\/codex-darwin-arm64/,
    ],
    [
      'an incoherent alias',
      {
        [LATEST_URL]: () =>
          json(
            latestDocument('0.156.0', {
              optionalDependencies: { '@openai/codex-darwin-arm64': 'npm:@openai/codex@0.150.0-darwin-arm64' },
            })
          ),
      },
      /coherent/,
    ],
  ])('rejects %s in the latest document', async (_name, routes, pattern) => {
    await expect(discoverCodexRelease('mac-arm64', undefined, { fetch: registryFetch(routes) })).rejects.toThrow(
      pattern
    )
  })

  it.each([
    ['an invalid hash', { integrity: 'sha1-abc' }, /SHA-512/],
    ['an external address', { tarball: 'https://evil.example/codex-0.156.0-darwin-arm64.tgz' }, /official URL/],
    ['an absurd unpacked size', { unpackedSize: 10 * 1024 ** 3 }, /unpacked size/],
    ['a missing unpacked size', { unpackedSize: undefined }, /unpacked size/],
  ])('rejects %s in the platform document', async (_name, dist, pattern) => {
    const routes = {
      [LATEST_URL]: () => json(latestDocument()),
      'https://registry.npmjs.org/@openai/codex/0.156.0-darwin-arm64': () => json(platformDocument('0.156.0', dist)),
    }
    await expect(discoverCodexRelease('mac-arm64', undefined, { fetch: registryFetch(routes) })).rejects.toThrow(
      pattern
    )
  })

  it('rejects platform documents for another version', async () => {
    const routes = {
      [LATEST_URL]: () => json(latestDocument()),
      'https://registry.npmjs.org/@openai/codex/0.156.0-darwin-arm64': () =>
        json(platformDocument('0.156.0', {}, { version: '0.150.0-darwin-arm64' })),
    }
    await expect(discoverCodexRelease('mac-arm64', undefined, { fetch: registryFetch(routes) })).rejects.toThrow(
      /does not describe/
    )
  })

  it('rejects redirects to other destinations but follows same-origin ones', async () => {
    const external = registryFetch({
      [LATEST_URL]: () => new Response(null, { status: 302, headers: { location: 'https://mirror.example/latest' } }),
    })
    await expect(discoverCodexRelease('mac-arm64', undefined, { fetch: external })).rejects.toThrow(
      /another destination/
    )

    const sameOrigin = registryFetch({
      ...standardRoutes(),
      [LATEST_URL]: () => new Response(null, { status: 301, headers: { location: '/@openai/codex/0.156.0' } }),
      'https://registry.npmjs.org/@openai/codex/0.156.0': () => json(latestDocument()),
    })
    await expect(discoverCodexRelease('mac-arm64', undefined, { fetch: sameOrigin })).resolves.toMatchObject({
      version: '0.156.0',
    })
  })

  it('rejects oversized responses by header and by streamed body', async () => {
    const declared = registryFetch({
      [LATEST_URL]: () => json(latestDocument(), { headers: { 'content-length': String(10 * 1024 * 1024) } }),
    })
    await expect(discoverCodexRelease('mac-arm64', undefined, { fetch: declared })).rejects.toThrow(/exceeds/)

    const streamed = registryFetch({
      [LATEST_URL]: () => new Response(`{"padding":"${'x'.repeat(4096)}"}`),
    })
    await expect(
      discoverCodexRelease('mac-arm64', undefined, { fetch: streamed, maxResponseBytes: 1024 })
    ).rejects.toThrow(/exceeds 1024 bytes/)
  })

  it('times out slow registries and reports unavailability as discovery errors', async () => {
    const hung = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        )
    )
    await expect(discoverCodexRelease('mac-arm64', undefined, { fetch: hung, timeoutMs: 20 })).rejects.toThrow(
      /Timed out/
    )

    const offline = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed')
    })
    const error = await discoverCodexRelease('mac-arm64', undefined, { fetch: offline }).catch((cause) => cause)
    expect(error).toBeInstanceOf(CodexReleaseDiscoveryError)
    expect(String(error.message)).toMatch(/Unable to check/)

    const unavailable = registryFetch({ [LATEST_URL]: () => new Response('down', { status: 503 }) })
    await expect(discoverCodexRelease('mac-arm64', undefined, { fetch: unavailable })).rejects.toThrow(/503/)
  })

  it('propagates caller cancellation', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      controller.abort(new Error('stop'))
      throw controller.signal.reason
    })
    await expect(discoverCodexRelease('mac-arm64', controller.signal, { fetch: fetchImpl })).rejects.toThrow('stop')
  })

  it('caps the download ceiling explicitly', () => {
    expect(codexDownloadCeiling(1_400_000_000, 10)).toBe(CODEX_MAX_DOWNLOAD_BYTES)
    expect(codexDownloadCeiling(100_000_000)).toBeGreaterThan(100_000_000)
  })
})

function memoryStorage(initial: string | null = null) {
  let value = initial
  const storage: CodexReleaseStorage & { value: () => string | null } = {
    read: vi.fn(() => value),
    write: vi.fn((next: string) => {
      value = next
    }),
    value: () => value,
  }
  return storage
}

async function discovered(version: string): Promise<RuntimeAssetDefinition> {
  return discoverCodexRelease('mac-arm64', undefined, { fetch: registryFetch(standardRoutes(version)) })
}

describe('CodexReleaseStore', () => {
  const embedded = RUNTIME_ASSET_REGISTRY['codex-runtime']
  const now = () => new Date('2026-09-22T12:00:00.000Z')

  it('defaults to notify-only and persists the automatic preference', () => {
    const storage = memoryStorage()
    const store = new CodexReleaseStore({ storage, target: 'mac-arm64', embedded, now })
    expect(store.automatic).toBe(false)
    store.setAutomatic(true)

    const reloaded = new CodexReleaseStore({ storage, target: 'mac-arm64', embedded, now })
    expect(reloaded.automatic).toBe(true)
  })

  it('records a checked candidate without accepting it for activation', async () => {
    const storage = memoryStorage()
    const store = new CodexReleaseStore({ storage, target: 'mac-arm64', embedded, now })
    store.recordCheck(await discovered('0.156.0'))

    expect(store.lastCheckedAt).toBe('2026-09-22T12:00:00.000Z')
    expect(store.candidate()?.version).toBe('0.156.0')
    expect(store.acceptedDefinition('0.156.0')).toBeNull()
  })

  it('recognizes an accepted dynamic version after an offline restart', async () => {
    const storage = memoryStorage()
    const definition = await discovered('0.156.0')
    new CodexReleaseStore({ storage, target: 'mac-arm64', embedded, now }).accept(definition, 1)

    const restarted = new CodexReleaseStore({ storage, target: 'mac-arm64', embedded, now })
    expect(restarted.acceptedDefinition('0.156.0')).toEqual(definition)
    expect(restarted.acceptedRelease('0.156.0')).toMatchObject({ compatibilityRevision: 1 })
    // Other hosts' profiles never reuse this target's metadata.
    expect(
      new CodexReleaseStore({ storage, target: 'linux-x64', embedded, now }).acceptedDefinition('0.156.0')
    ).toBeNull()
  })

  it('never accepts versions older than the embedded pin', async () => {
    const storage = memoryStorage()
    const store = new CodexReleaseStore({ storage, target: 'mac-arm64', embedded, now })
    store.accept(await discovered('0.150.0'), 1)
    expect(store.acceptedDefinition('0.150.0')).toBeNull()
    // The embedded version is served by the registry itself.
    store.accept(await discovered(embedded.version), 1)
    expect(store.acceptedDefinition(embedded.version)).toBeNull()
  })

  it('drops tampered records instead of trusting them', async () => {
    const storage = memoryStorage()
    new CodexReleaseStore({ storage, target: 'mac-arm64', embedded, now }).accept(await discovered('0.156.0'), 1)
    const tampered = storage
      .value()!
      .replace(
        'https://registry.npmjs.org/@openai/codex/-/codex-0.156.0-darwin-arm64.tgz',
        'https://evil.example/codex.tgz'
      )
    const reloaded = new CodexReleaseStore({ storage: memoryStorage(tampered), target: 'mac-arm64', embedded, now })
    expect(reloaded.acceptedDefinition('0.156.0')).toBeNull()
    expect(
      new CodexReleaseStore({ storage: memoryStorage('{not json'), target: 'mac-arm64', embedded, now }).automatic
    ).toBe(false)
  })

  it('tracks rejection, revalidation, and pruning', async () => {
    const storage = memoryStorage()
    const store = new CodexReleaseStore({ storage, target: 'mac-arm64', embedded, now })
    store.accept(await discovered('0.156.0'), 0)
    store.accept(await discovered('0.157.0'), 1)
    store.reject('0.157.0', 'rollback')
    expect(store.rejected()).toEqual({ version: '0.157.0', reason: 'rollback' })
    store.clearRejection('0.156.0')
    expect(store.rejected()).not.toBeNull()
    store.clearRejection()
    expect(store.rejected()).toBeNull()

    store.markValidated('0.156.0', 1)
    expect(store.acceptedRelease('0.156.0')?.compatibilityRevision).toBe(1)
    store.prune(['0.157.0'])
    expect(store.acceptedDefinition('0.156.0')).toBeNull()
    expect(store.acceptedDefinition('0.157.0')?.version).toBe('0.157.0')
  })

  it('reports unavailable storage without caching the failure', () => {
    let fail = true
    const storage: CodexReleaseStorage = {
      read: () => {
        if (fail) throw new Error('database closed')
        return null
      },
      write: () => undefined,
    }
    const store = new CodexReleaseStore({ storage, target: 'mac-arm64', embedded, now })
    expect(() => store.acceptedDefinition('0.156.0')).toThrow(CodexReleaseMetadataUnavailableError)
    fail = false
    expect(store.acceptedDefinition('0.156.0')).toBeNull()
  })

  it('leaves state unchanged when persistence fails', async () => {
    const storage = memoryStorage()
    const store = new CodexReleaseStore({ storage, target: 'mac-arm64', embedded, now })
    const definition = await discovered('0.156.0')
    vi.mocked(storage.write).mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    expect(() => store.accept(definition, 1)).toThrow('disk full')
    expect(store.acceptedDefinition('0.156.0')).toBeNull()
  })
})
