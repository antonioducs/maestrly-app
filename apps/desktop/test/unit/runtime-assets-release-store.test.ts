import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { UpdatableRuntimeAssetId } from '../../src/shared/runtime-assets'
import type { RuntimeAssetDefinition, RuntimeTargetId } from '../../src/main/runtime-assets/registry'
import type { RuntimeReleaseProfile } from '../../src/main/runtime-assets/release-profile'
import { RuntimeReleaseStore, type RuntimeReleaseStorage } from '../../src/main/runtime-assets/release-store'

// A profile unrelated to Codex: the store must take every runtime-specific rule from it.
const FAKE_ID = 'claude-code-runtime' as unknown as UpdatableRuntimeAssetId
const fakeUrl = (version: string, target: RuntimeTargetId) =>
  `https://registry.npmjs.org/fake-${target}/-/fake-${target}-${version}.tgz`
const FAKE_PROFILE: RuntimeReleaseProfile = {
  id: FAKE_ID,
  label: 'Fake',
  maxDownloadBytes: 1_000,
  maxUnpackedBytes: 2_000,
  supportsTarget: (target) => target === 'linux-arm64',
  artifactUrl: fakeUrl,
  createTarget: (id, version, metadata) => ({
    id,
    url: fakeUrl(version, id),
    archive: 'tar.gz',
    hash: { algorithm: 'sha512', digest: metadata.sha512Base64, encoding: 'base64' },
    downloadBytes: metadata.downloadBytes,
    maxDownloadBytes: metadata.maxDownloadBytes,
    unpackedBytes: metadata.unpackedBytes,
    stripPrefix: 'package',
    criticalPaths: ['fake'],
    executablePath: 'fake',
  }),
}

function definition(
  version: string,
  overrides: { id?: string; url?: string; target?: RuntimeTargetId } = {}
): RuntimeAssetDefinition {
  const target = overrides.target ?? 'linux-arm64'
  const entry = FAKE_PROFILE.createTarget(target, version, {
    sha512Base64: createHash('sha512').update(version).digest('base64'),
    downloadBytes: 100,
    maxDownloadBytes: 200,
    unpackedBytes: 300,
  })
  return {
    id: (overrides.id ?? FAKE_ID) as RuntimeAssetDefinition['id'],
    version,
    targets: { [target]: overrides.url ? { ...entry, url: overrides.url } : entry },
  }
}

function memoryStorage(initial: string | null = null): RuntimeReleaseStorage & { value: () => string | null } {
  let value = initial
  return {
    read: () => value,
    write: (next) => {
      value = next
    },
    value: () => value,
  }
}

function store(storage: RuntimeReleaseStorage, automaticDefault?: boolean) {
  return new RuntimeReleaseStore({
    profile: FAKE_PROFILE,
    storage,
    target: 'linux-arm64',
    embedded: definition('1.0.0'),
    ...(automaticDefault === undefined ? {} : { automaticDefault }),
    now: () => new Date('2026-09-29T12:00:00.000Z'),
  })
}

describe('RuntimeReleaseStore with a non-Codex profile', () => {
  it('accepts only definitions of its own runtime', () => {
    expect(() => store(memoryStorage()).accept(definition('1.1.0', { id: 'codex-runtime' }), 1)).toThrow()
    const storage = memoryStorage()
    store(storage).accept(definition('1.1.0'), 1)
    expect(store(storage).acceptedDefinition('1.1.0')).toEqual(definition('1.1.0'))
  })

  it('never trusts an artifact outside the profile canonical URL', () => {
    expect(() =>
      store(memoryStorage()).accept(definition('1.1.0', { url: 'https://evil.example/fake.tgz' }), 1)
    ).toThrow(/not an official/)

    const storage = memoryStorage()
    store(storage).accept(definition('1.1.0'), 1)
    const tampered = storage.value()!.replace(fakeUrl('1.1.0', 'linux-arm64'), 'https://evil.example/fake.tgz')
    expect(store(memoryStorage(tampered)).acceptedDefinition('1.1.0')).toBeNull()
  })

  it('rejects targets and sizes the profile does not allow', () => {
    expect(() => store(memoryStorage()).recordCheck(definition('1.1.0', { target: 'mac-arm64' }))).toThrow()
    const oversized: RuntimeAssetDefinition = {
      ...definition('1.1.0'),
      targets: {
        'linux-arm64': { ...definition('1.1.0').targets['linux-arm64']!, unpackedBytes: 5_000 },
      },
    }
    expect(() => store(memoryStorage()).accept(oversized, 1)).toThrow()
  })

  it('uses the automatic default only until a preference is stored', () => {
    const storage = memoryStorage()
    expect(store(storage, true).automatic).toBe(true)
    expect(store(memoryStorage()).automatic).toBe(false)
    store(storage, true).setAutomatic(false)
    expect(store(storage, true).automatic).toBe(false)
  })

  it('keeps the embedded version as the floor', () => {
    const storage = memoryStorage()
    store(storage).accept(definition('0.9.0'), 1)
    expect(store(storage).acceptedRelease('0.9.0')).toBeNull()
  })
})
