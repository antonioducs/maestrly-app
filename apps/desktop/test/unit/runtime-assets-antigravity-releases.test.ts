import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  ANTIGRAVITY_RELEASE_PROFILE,
  ANTIGRAVITY_TARGETS,
  antigravityArtifactUrl,
  discoverAntigravityRelease,
} from '../../src/main/runtime-assets/antigravity-releases'
import { createHttpsDownloader } from '../../src/main/runtime-assets/downloader'
import { RUNTIME_ASSET_REGISTRY, type RuntimeTargetId } from '../../src/main/runtime-assets/registry'
import { RuntimeReleaseStore } from '../../src/main/runtime-assets/release-store'
import { CODEX_RELEASE_PROFILE } from '../../src/main/runtime-assets/codex-releases'

function metadata(version = '1.3.0') {
  return {
    id: 'antigravity-acp',
    version,
    distribution: {
      binary: Object.fromEntries(
        Object.entries(ANTIGRAVITY_TARGETS).map(([target, [key]]) => [
          key,
          {
            archive: antigravityArtifactUrl(version, target as RuntimeTargetId),
            cmd: target.startsWith('win-') ? './agy_acp_server.exe' : './agy_acp_server.par',
            ...(target.startsWith('linux-') ? { args: ['--uid='] } : {}),
          },
        ])
      ),
    },
  }
}
function discovery(body: unknown = metadata()) {
  const fetch = vi.fn(async () => Response.json(body))
  return { fetch: fetch as unknown as typeof globalThis.fetch, spy: fetch }
}
function memoryStore(raw: string | null = null, profile = ANTIGRAVITY_RELEASE_PROFILE) {
  let value = raw
  const options = {
    profile,
    storage: {
      read: () => value,
      write: (next: string) => {
        value = next
      },
    },
    target: 'mac-arm64' as const,
    embedded: RUNTIME_ASSET_REGISTRY[profile.id],
  }
  return { store: new RuntimeReleaseStore(options), reload: () => new RuntimeReleaseStore(options), value: () => value }
}

describe('Antigravity release discovery and persisted provenance', () => {
  it.each(Object.keys(ANTIGRAVITY_TARGETS) as RuntimeTargetId[])('checks only metadata for %s', async (target) => {
    const deps = discovery()
    const release = await discoverAntigravityRelease(target, undefined, deps)
    expect(deps.spy).toHaveBeenCalledTimes(1)
    expect(deps.spy).toHaveBeenCalledWith(
      expect.stringContaining('/agent.json'),
      expect.objectContaining({ redirect: 'manual' })
    )
    expect(release.targets[target]?.hash).toEqual({
      algorithm: 'sha256',
      encoding: 'hex',
      provenance: 'google-origin-pending',
    })
    expect(release.targets[target]?.criticalPaths).toHaveLength(2)
  })
  it('retains authoritative embedded checksums', async () => {
    expect(await discoverAntigravityRelease('mac-arm64', undefined, discovery(metadata('1.2.1')))).toBe(
      RUNTIME_ASSET_REGISTRY['antigravity-acp-runtime']
    )
  })
  it.each(['1.2.3-beta', '../1.2.3', '01.2.3', '9999999999.0.0'])('rejects invalid version %s', async (version) => {
    await expect(discoverAntigravityRelease('mac-arm64', undefined, discovery(metadata(version)))).rejects.toThrow()
  })
  it.each([
    'http://dl.google.com/x',
    'https://dl.google.com.evil.test/x',
    'https://dl.google.com/../x',
    'https://user@dl.google.com/x',
  ])('rejects malicious artifact URL %s', async (archive) => {
    const body = metadata()
    body.distribution.binary['darwin-aarch64'].archive = archive
    await expect(discoverAntigravityRelease('mac-arm64', undefined, discovery(body))).rejects.toThrow()
  })
  it('rejects identity, commands, arguments and missing platforms', async () => {
    const identity = metadata()
    identity.id = 'other'
    const command = metadata()
    command.distribution.binary['darwin-aarch64'].cmd = './shell'
    const args = metadata()
    args.distribution.binary['linux-aarch64'].args = ['--credentials=/private']
    const missing = metadata()
    delete missing.distribution.binary['windows-aarch64']
    for (const body of [identity, command, args, missing])
      await expect(discoverAntigravityRelease('mac-arm64', undefined, discovery(body))).rejects.toThrow()
  })
  it('rejects redirects, declared and streamed oversized metadata', async () => {
    for (const response of [
      new Response(null, { status: 302, headers: { location: 'https://evil.test' } }),
      new Response('{}', { headers: { 'content-length': '999999' } }),
      new Response('x'.repeat(100)),
    ]) {
      await expect(
        discoverAntigravityRelease('mac-arm64', undefined, { fetch: vi.fn(async () => response), maxResponseBytes: 80 })
      ).rejects.toThrow()
    }
  })
  it('bounds metadata request time and propagates cancellation', async () => {
    const fetch: typeof globalThis.fetch = async (_url, options) =>
      new Promise((_, reject) => {
        const signal = options!.signal!
        if (signal.aborted) reject(signal.reason)
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    await expect(discoverAntigravityRelease('mac-arm64', undefined, { fetch, timeoutMs: 10 })).rejects.toThrow()
    const controller = new AbortController()
    const checking = discoverAntigravityRelease('mac-arm64', controller.signal, { fetch })
    controller.abort(new Error('cancelled'))
    await expect(checking).rejects.toThrow('cancelled')
  })

  it('round-trips pending candidates but never accepts them; stored digests override rediscovery', async () => {
    const release = await discoverAntigravityRelease('mac-arm64', undefined, discovery())
    const h = memoryStore()
    h.store.recordCheck(release)
    expect(h.reload().candidate()).toEqual(release)
    expect(() => h.store.accept(release, 1)).toThrow(/Pending/)
    const target = release.targets['mac-arm64']!
    const accepted = {
      ...release,
      targets: {
        'mac-arm64': {
          ...target,
          hash: { algorithm: 'sha256' as const, encoding: 'hex' as const, digest: 'a'.repeat(64) },
        },
      },
    }
    h.store.accept(accepted, 1)
    h.store.recordCheck(release)
    expect(h.reload().candidate()).toEqual(accepted)
    expect(h.reload().acceptedDefinition('1.3.0')).toEqual(accepted)
    expect(() =>
      h.store.accept(
        {
          ...accepted,
          targets: {
            'mac-arm64': { ...target, hash: { algorithm: 'sha256', encoding: 'hex', digest: 'b'.repeat(64) } },
          },
        },
        1
      )
    ).toThrow(/cannot change/)
    const state = JSON.parse(h.value()!)
    state.accepted[0].artifact = state.candidate.artifact
    expect(memoryStore(JSON.stringify(state)).store.acceptedDefinition('1.3.0')).toBeNull()
  })
  it('rejects pending provenance in npm stores and invalid size ceilings', async () => {
    const release = await discoverAntigravityRelease('mac-arm64', undefined, discovery())
    const h = memoryStore()
    h.store.recordCheck(release)
    expect(memoryStore(h.value(), CODEX_RELEASE_PROFILE).store.candidate()).toBeNull()
    for (const size of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER]) {
      const state = JSON.parse(h.value()!)
      state.candidate.artifact.maxDownloadBytes = size
      expect(memoryStore(JSON.stringify(state)).store.candidate()).toBeNull()
    }
  })
  it('does not follow Google archive redirects and computes the accepted local digest', async () => {
    const release = await discoverAntigravityRelease('mac-arm64', undefined, discovery())
    const target = release.targets['mac-arm64']!
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'agy-download-'))
    try {
      const redirect = vi.fn(
        async () => new Response(null, { status: 302, headers: { location: 'https://dl.google.com/elsewhere' } })
      )
      await expect(
        createHttpsDownloader({ fetch: redirect })(target, path.join(temporary, 'redirect'), {
          signal: new AbortController().signal,
        })
      ).rejects.toThrow(/redirect/)
      expect(redirect).toHaveBeenCalledTimes(1)
      const downloaded = await createHttpsDownloader({ fetch: vi.fn(async () => new Response('abc')) })(
        target,
        path.join(temporary, 'archive'),
        { signal: new AbortController().signal }
      )
      expect(downloaded.digest).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })
})
