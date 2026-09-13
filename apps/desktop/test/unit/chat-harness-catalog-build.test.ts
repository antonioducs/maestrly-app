import { afterEach, describe, expect, it } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HARNESS_PROFILES_DIR, readHarnessSources, validateHarnessCatalog } from '../../build/harness-catalog'
import { harnessCatalogSources, harnessRegistry } from '../../src/main/chat/harness/catalog'
import { createHarnessRegistry } from '../../src/main/chat/harness/registry'
import { resolveHarness } from '../../src/main/chat/harness/resolver'

const created: string[] = []

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'maestrly-harness-'))
  created.push(dir)
  cpSync(fileURLToPath(new URL('../../src/main/chat/harness/profiles/default', import.meta.url)), join(dir, 'default'), {
    recursive: true,
  })
  return dir
}

function addProfile(root: string, folder: string, config: unknown, files: Record<string, string> = {}): void {
  mkdirSync(join(root, folder), { recursive: true })
  writeFileSync(join(root, folder, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, folder, name), body)
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('harness catalog discovery', () => {
  it('produces identical sources through the bundler glob and the build scanner', () => {
    expect(harnessCatalogSources()).toEqual(readHarnessSources(HARNESS_PROFILES_DIR))
  })

  it('validates the shipped catalog with the same pure core the runtime uses', () => {
    const built = validateHarnessCatalog()
    expect(built.list().map((profile) => profile.folderId)).toEqual(
      harnessRegistry().list().map((profile) => profile.folderId)
    )
    expect(built.default.folderId).toBe('default')
  })

  it('picks up a new folder and drops it again without touching any list', () => {
    const root = scratch()
    expect(createHarnessRegistry(readHarnessSources(root)).get('fictional-model')).toBeNull()
    addProfile(
      root,
      'fictional-model',
      {
        schemaVersion: 1,
        id: 'fictional-model',
        profileVersion: 1,
        bindings: [{ providerKind: '*', overrides: { prompts: { styleAndWork: 'prompt.md' } } }],
      },
      { 'prompt.md': 'FICTIONAL SENTINEL' }
    )
    const registry = createHarnessRegistry(readHarnessSources(root))
    const resolution = resolveHarness({ providerKind: 'anthropic', requestedModelId: 'fictional-model' }, registry)
    expect(resolution.ok && resolution.harness.prompts.styleAndWork).toBe('FICTIONAL SENTINEL')

    rmSync(join(root, 'fictional-model'), { recursive: true, force: true })
    const after = createHarnessRegistry(readHarnessSources(root))
    const fallback = resolveHarness({ providerKind: 'anthropic', requestedModelId: 'fictional-model' }, after)
    expect(fallback.ok && fallback.harness.profileId).toBe('default')
  })

  it('fails the build for an invalid profile, naming the profile and field', () => {
    const root = scratch()
    addProfile(root, 'broken', '{ not json')
    expect(() => validateHarnessCatalog(root)).toThrow(/\[harness:broken\] config\.json: invalid JSON/)
  })

  it('fails when a folder has no config.json', () => {
    const root = scratch()
    mkdirSync(join(root, 'empty'))
    expect(() => validateHarnessCatalog(root)).toThrow(/missing config\.json/)
    writeFileSync(join(root, 'empty', 'prompt.md'), 'x')
    expect(() => validateHarnessCatalog(root)).toThrow(/missing config\.json/)
  })

  it('rejects symlinked profiles and files', () => {
    const root = scratch()
    symlinkSync(join(root, 'default'), join(root, 'linked'))
    expect(() => validateHarnessCatalog(root)).toThrow(/must be a real profile directory|regular file/)
  })

  it('is not affected by the presence of the source tree', () => {
    const root = scratch()
    addProfile(
      root,
      'packaged-model',
      {
        schemaVersion: 1,
        id: 'packaged-model',
        profileVersion: 1,
        bindings: [{ providerKind: '*', overrides: { prompts: { styleAndWork: 'prompt.md' } } }],
      },
      { 'prompt.md': 'PACKAGED SENTINEL' }
    )
    // The registry only ever consumes plain sources: no cwd, absolute path or `src/` lookup at runtime.
    const sources = readHarnessSources(root)
    rmSync(root, { recursive: true, force: true })
    const registry = createHarnessRegistry(sources)
    const resolution = resolveHarness({ providerKind: 'anthropic', requestedModelId: 'packaged-model' }, registry)
    expect(resolution.ok && resolution.harness.prompts.styleAndWork).toBe('PACKAGED SENTINEL')
  })
})
