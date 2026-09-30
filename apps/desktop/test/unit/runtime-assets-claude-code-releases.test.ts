import { describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_CODE_MAX_UNPACKED_BYTES,
  CLAUDE_CODE_RELEASE_PROFILE,
  discoverClaudeCodeRelease,
} from '../../src/main/runtime-assets/claude-code-releases'
import { RuntimeReleaseDiscoveryError, npmDownloadCeiling } from '../../src/main/runtime-assets/npm-registry'
import { claudeCodeArtifactUrl } from '../../src/main/runtime-assets/registry'

const INTEGRITY = `sha512-${'Q'.repeat(86)}==`
const LATEST_URL = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest'
const platformUrl = (version: string) => `https://registry.npmjs.org/@anthropic-ai/claude-code-linux-arm64/${version}`

function latestDocument(version = '2.1.290', overrides: Record<string, unknown> = {}) {
  return {
    name: '@anthropic-ai/claude-code',
    version,
    optionalDependencies: {
      '@anthropic-ai/claude-code-linux-arm64': version,
      '@anthropic-ai/claude-code-linux-x64': version,
      '@anthropic-ai/claude-code-darwin-arm64': version,
    },
    ...overrides,
  }
}

function platformDocument(version = '2.1.290', dist: Record<string, unknown> = {}, overrides = {}) {
  return {
    name: '@anthropic-ai/claude-code-linux-arm64',
    version,
    os: ['linux'],
    cpu: ['arm64'],
    dist: {
      tarball: `https://registry.npmjs.org/@anthropic-ai/claude-code-linux-arm64/-/claude-code-linux-arm64-${version}.tgz`,
      integrity: INTEGRITY,
      unpackedSize: 239_723_082,
      fileCount: 4,
      ...dist,
    },
    ...overrides,
  }
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

/** Strict fake registry: only the listed URLs answer; anything else is a 404. */
function registryFetch(routes: Record<string, () => Response | Promise<Response>>) {
  return vi.fn<typeof fetch>(async (input) => {
    const route = routes[String(input)]
    if (!route) return new Response('not found', { status: 404 })
    return route()
  })
}

function standardRoutes(version = '2.1.290') {
  return {
    [LATEST_URL]: () => json(latestDocument(version)),
    [platformUrl(version)]: () => json(platformDocument(version)),
  }
}

describe('discoverClaudeCodeRelease', () => {
  it('builds a verified single-target definition from the latest release', async () => {
    const fetchImpl = registryFetch(standardRoutes())
    const definition = await discoverClaudeCodeRelease('linux-arm64', undefined, { fetch: fetchImpl })

    expect(definition).toMatchObject({ id: 'claude-code-runtime', version: '2.1.290' })
    expect(Object.keys(definition.targets)).toEqual(['linux-arm64'])
    expect(definition.targets['linux-arm64']).toMatchObject({
      url: claudeCodeArtifactUrl('2.1.290', 'linux-arm64'),
      archive: 'tar.gz',
      hash: { algorithm: 'sha512', encoding: 'base64', digest: `${'Q'.repeat(86)}==` },
      unpackedBytes: 239_723_082,
      maxDownloadBytes: npmDownloadCeiling(239_723_082, 4, CLAUDE_CODE_RELEASE_PROFILE.maxDownloadBytes),
      stripPrefix: 'package',
      criticalPaths: ['claude', 'package.json'],
      executablePath: 'claude',
    })
    const target = definition.targets['linux-arm64']!
    expect(target.downloadBytes).toBeLessThanOrEqual(target.maxDownloadBytes)
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([LATEST_URL, platformUrl('2.1.290')])
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'manual' })
  })

  it.each([
    ['a prerelease', { [LATEST_URL]: () => json(latestDocument('2.1.290-beta')) }, /not a stable version/],
    [
      'another package',
      { [LATEST_URL]: () => json(latestDocument('2.1.290', { name: '@evil/claude-code' })) },
      /does not describe/,
    ],
    [
      'an incoherent platform version',
      {
        [LATEST_URL]: () =>
          json(
            latestDocument('2.1.290', { optionalDependencies: { '@anthropic-ai/claude-code-linux-arm64': '2.1.1' } })
          ),
      },
      /coherent/,
    ],
    [
      'a missing platform',
      { [LATEST_URL]: () => json(latestDocument('2.1.290', { optionalDependencies: {} })) },
      /coherent/,
    ],
  ])('rejects %s in the latest document', async (_name, routes, pattern) => {
    await expect(discoverClaudeCodeRelease('linux-arm64', undefined, { fetch: registryFetch(routes) })).rejects.toThrow(
      pattern
    )
  })

  it.each([
    ['a non-canonical tarball', { tarball: 'https://evil.example/claude.tgz' }, /official URL/],
    ['a SHA-1 integrity', { integrity: 'sha1-abc' }, /SHA-512/],
    ['an absurd unpacked size', { unpackedSize: CLAUDE_CODE_MAX_UNPACKED_BYTES + 1 }, /unpacked size/],
    ['a missing unpacked size', { unpackedSize: undefined }, /unpacked size/],
  ])('rejects %s in the platform document', async (_name, dist, pattern) => {
    const routes = {
      [LATEST_URL]: () => json(latestDocument()),
      [platformUrl('2.1.290')]: () => json(platformDocument('2.1.290', dist)),
    }
    await expect(discoverClaudeCodeRelease('linux-arm64', undefined, { fetch: registryFetch(routes) })).rejects.toThrow(
      pattern
    )
  })

  it('rejects a platform document for another package or version', async () => {
    for (const overrides of [{ version: '2.1.1' }, { name: '@anthropic-ai/claude-code-linux-x64' }]) {
      const routes = {
        [LATEST_URL]: () => json(latestDocument()),
        [platformUrl('2.1.290')]: () => json(platformDocument('2.1.290', {}, overrides)),
      }
      await expect(
        discoverClaudeCodeRelease('linux-arm64', undefined, { fetch: registryFetch(routes) })
      ).rejects.toThrow(/does not describe/)
    }
  })

  it('rejects redirects to other destinations', async () => {
    const external = registryFetch({
      [LATEST_URL]: () => new Response(null, { status: 302, headers: { location: 'https://mirror.example/latest' } }),
    })
    await expect(discoverClaudeCodeRelease('linux-arm64', undefined, { fetch: external })).rejects.toThrow(
      /another destination/
    )
  })

  it('refuses targets Claude Code is not managed for', async () => {
    const fetchImpl = registryFetch(standardRoutes())
    const error = await discoverClaudeCodeRelease('mac-arm64', undefined, { fetch: fetchImpl }).catch((cause) => cause)
    expect(error).toBeInstanceOf(RuntimeReleaseDiscoveryError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports unavailability and timeouts as discovery errors', async () => {
    const offline = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed')
    })
    const error = await discoverClaudeCodeRelease('linux-arm64', undefined, { fetch: offline }).catch((cause) => cause)
    expect(error).toBeInstanceOf(RuntimeReleaseDiscoveryError)
    expect(String(error.message)).toMatch(/Unable to check/)

    const hung = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        )
    )
    await expect(discoverClaudeCodeRelease('linux-arm64', undefined, { fetch: hung, timeoutMs: 20 })).rejects.toThrow(
      /Timed out/
    )
  })
})

describe('CLAUDE_CODE_RELEASE_PROFILE', () => {
  it('manages only the Linux targets bots run on', () => {
    expect(CLAUDE_CODE_RELEASE_PROFILE.id).toBe('claude-code-runtime')
    expect(CLAUDE_CODE_RELEASE_PROFILE.supportsTarget('linux-arm64')).toBe(true)
    expect(CLAUDE_CODE_RELEASE_PROFILE.supportsTarget('linux-x64')).toBe(true)
    expect(CLAUDE_CODE_RELEASE_PROFILE.supportsTarget('mac-arm64')).toBe(false)
    expect(CLAUDE_CODE_RELEASE_PROFILE.artifactUrl('2.1.290', 'linux-x64')).toBe(
      'https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-2.1.290.tgz'
    )
  })
})
