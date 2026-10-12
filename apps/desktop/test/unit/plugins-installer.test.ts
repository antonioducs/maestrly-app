import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginGitSource } from '../../src/main/plugins/git-source'
import { inspectTree } from '../../src/main/plugins/inspect'
import {
  type InstallerDeps,
  type PreparedInstall,
  copyPluginTree,
  installPrepared,
  reconcilePlugins,
  uninstallPlugin,
  updatePrepared,
} from '../../src/main/plugins/installer'
import { pluginKeyHash, pluginLayout } from '../../src/main/plugins/layout'
import type { MarketplaceEntry } from '../../src/main/plugins/marketplace'
import { fsPackageTree, gitPackageTree, type TreeEntry } from '../../src/main/plugins/package-tree'
import { listInstalled, readPluginSecrets, writeInstalled, writePluginSecrets } from '../../src/main/plugins/store'
import { closeDb, freshDb } from '../helpers/db'
import { type FixtureFiles, makeGitRepo, writeTree } from '../helpers/plugin-fixtures'

const secrets = vi.hoisted(() => ({ values: new Map<string, string>(), available: true }))
vi.mock('../../src/main/secure-store', () => ({
  isSecureStorageAvailable: () => secrets.available,
  secureGet: (key: string) => (secrets.available ? (secrets.values.get(key) ?? null) : null),
  secureSet: (key: string, value: string) => {
    if (!secrets.available) return false
    secrets.values.set(key, value)
    return true
  },
  secureRemove: (key: string) => secrets.values.delete(key),
}))

const entry = (name: string): MarketplaceEntry => ({
  name,
  source: { kind: 'path', path: '' },
  policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: [] },
  category: null,
  display: {},
})
const demo = (args: string[] = ['./mcp/server.mjs'], extra: FixtureFiles = {}): FixtureFiles => ({
  '.codex-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
  'skills/hello/SKILL.md': '---\ndescription: Say hello\n---\nHello.',
  '.mcp.json': JSON.stringify({
    mcpServers: {
      local: { command: 'node', args, env_vars: ['API_TOKEN'] },
      remote: { url: 'https://mcp.example.com/mcp' },
    },
  }),
  'mcp/server.mjs': 'process.exit(0)\n',
  ...extra,
})

let deps: InstallerDeps & {
  invalidateServer: ReturnType<typeof vi.fn<(id: string) => void>>
  forgetServer: ReturnType<typeof vi.fn<(id: string) => void>>
  onSkillsRemoved: ReturnType<typeof vi.fn<(names: string[]) => void>>
}
let base: string

async function prepare(dir: string, key = 'demo@market'): Promise<PreparedInstall> {
  const tree = await fsPackageTree(dir)
  return {
    key,
    name: key.split('@')[0],
    marketplaceId: 'mkt_1',
    source: { kind: 'marketplace', path: '' },
    commit: 'a'.repeat(40),
    treeOid: 'b'.repeat(40),
    checkoutDir: dir,
    entries: [...tree.entries.values()],
    inspection: await inspectTree(tree, entry(key.split('@')[0])),
  }
}
const consentFor = (p: PreparedInstall, stdio: string[] = ['local'], executables = true) => ({
  consentFingerprint: p.inspection.consentFingerprint,
  stdio,
  executables,
})

beforeEach(() => {
  freshDb()
  secrets.values.clear()
  secrets.available = true
  base = mkdtempSync(path.join(os.tmpdir(), 'plg-install-'))
  deps = {
    layout: pluginLayout(base),
    now: () => Date.now(),
    invalidateServer: vi.fn(),
    forgetServer: vi.fn(),
    onSkillsRemoved: vi.fn(),
  }
})
afterEach(() => closeDb())

describe('plugin installer', () => {
  it('installs from a real Git checkout and skips symlinks and submodules', async () => {
    const repo = await makeGitRepo(
      { ...demo(), 'skills/hello/link': { symlink: '../../outside' } },
      { submodule: 'vendor/sub' }
    )
    const git = new PluginGitSource({ allowFileRoot: path.dirname(repo.dir) })
    const work = mkdtempSync(path.join(os.tmpdir(), 'plg-checkout-'))
    const commit = await git.fetch(work, { url: pathToFileURL(repo.dir).href, ref: null, sha: null })
    const entries = await git.listTree(work, commit)
    await git.checkout(work, commit, ['/*'])
    const tree = gitPackageTree(work, entries)
    const inspection = await inspectTree(tree, entry('demo'))
    const prepared: PreparedInstall = {
      key: 'demo@market',
      name: 'demo',
      marketplaceId: 'mkt_1',
      source: { kind: 'marketplace', path: '' },
      commit,
      treeOid: (await git.treeOid(work, commit, ''))!,
      checkoutDir: work,
      entries,
      inspection,
    }
    const result = await installPrepared(prepared, { consent: consentFor(prepared), scope: { kind: 'global' } }, deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const record = result.value
    expect(record).toMatchObject({ status: 'ready', commit, skillNames: ['demo:hello'] })
    expect(record.servers.local.id).toMatch(/^plg_/)
    expect(record.servers.local.enabled).toBe(true)
    const dir = deps.layout.packageDir(pluginKeyHash('demo@market'), record.dirName)
    expect(existsSync(path.join(dir, 'skills/hello/SKILL.md'))).toBe(true)
    expect(existsSync(path.join(dir, 'skills/hello/link'))).toBe(false)
    expect(existsSync(path.join(dir, 'vendor/sub'))).toBe(false)
    expect(existsSync(deps.layout.data(pluginKeyHash('demo@market')))).toBe(true)
  })

  it('copies with fixed modes and reports skipped links', async () => {
    const src = await writeTree({
      'a.sh': { content: '#!/bin/sh', mode: 0o700 },
      'b.txt': 'x',
      l: { symlink: 'b.txt' },
    })
    const dest = path.join(mkdtempSync(path.join(os.tmpdir(), 'plg-copy-')), 'out')
    const tree = await fsPackageTree(src)
    const result = await copyPluginTree(src, [...tree.entries.values()], dest)
    expect(result.files).toBe(2)
    expect(result.skipped).toEqual([{ path: 'l', reason: 'symlink-skipped' }])
    expect(statSync(path.join(dest, 'a.sh')).mode & 0o777).toBe(0o755)
    expect(statSync(path.join(dest, 'b.txt')).mode & 0o777).toBe(0o644)
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('enforces file count, file size and path limits', async () => {
    const src = mkdtempSync(path.join(os.tmpdir(), 'plg-limits-'))
    const dest = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'plg-dest-')), 'out')
    const many: TreeEntry[] = Array.from({ length: 4_001 }, (_, i) => ({ path: `f${i}.txt`, mode: 'file' }))
    await expect(copyPluginTree(src, many, dest())).rejects.toThrow('limit-exceeded:files')
    writeFileSync(path.join(src, 'big.bin'), '')
    truncateSync(path.join(src, 'big.bin'), 17 * 1024 * 1024)
    await expect(copyPluginTree(src, [{ path: 'big.bin', mode: 'file' }], dest())).rejects.toThrow(
      'limit-exceeded:file-size'
    )
    await expect(copyPluginTree(src, [{ path: '../x', mode: 'file' }], dest())).rejects.toThrow('path-unsafe')
    await expect(copyPluginTree(src, [{ path: `${'a/'.repeat(30)}x`, mode: 'file' }], dest())).rejects.toThrow(
      'limit-exceeded:depth'
    )
  })

  it('requires consent for executables and leaves unconsented stdio servers off', async () => {
    const withScript = await prepare(
      await writeTree(demo(undefined, { 'scripts/run.sh': { content: 'x', mode: 0o755 } }))
    )
    const refused = await installPrepared(
      withScript,
      { consent: consentFor(withScript, ['local'], false), scope: { kind: 'global' } },
      deps
    )
    expect(refused).toMatchObject({ ok: false, error: 'consent-required' })
    const plain = await prepare(await writeTree(demo()))
    const result = await installPrepared(plain, { consent: consentFor(plain, []), scope: { kind: 'global' } }, deps)
    expect(result.ok && result.value.servers.local.enabled).toBe(false)
    expect(result.ok && result.value.servers.remote.enabled).toBe(true)
  })

  it('refuses a stale consent fingerprint, duplicates and name conflicts', async () => {
    const p = await prepare(await writeTree(demo()))
    expect(
      await installPrepared(
        p,
        { consent: { ...consentFor(p), consentFingerprint: 'stale' }, scope: { kind: 'global' } },
        deps
      )
    ).toMatchObject({ ok: false, error: 'consent-required', detail: p.inspection.consentFingerprint })
    expect((await installPrepared(p, { consent: consentFor(p), scope: { kind: 'global' } }, deps)).ok).toBe(true)
    expect(await installPrepared(p, { consent: consentFor(p), scope: { kind: 'global' } }, deps)).toMatchObject({
      ok: false,
      error: 'already-installed',
    })
    const other = await prepare(await writeTree(demo()), 'demo@other')
    expect(await installPrepared(other, { consent: consentFor(other), scope: { kind: 'global' } }, deps)).toMatchObject(
      {
        ok: false,
        error: 'name-conflict',
      }
    )
  })

  it('stores inputs encrypted and writes nothing without secure storage', async () => {
    const p = await prepare(await writeTree(demo()))
    secrets.available = false
    const failed = await installPrepared(
      p,
      { consent: consentFor(p), scope: { kind: 'global' }, inputs: { 'env:local:API_TOKEN': 'synthetic' } },
      deps
    )
    expect(failed).toMatchObject({ ok: false, error: 'secure-storage-unavailable' })
    expect(listInstalled()).toEqual({})
    expect(existsSync(path.join(base, 'packages'))).toBe(false)
    secrets.available = true
    const ok = await installPrepared(
      p,
      { consent: consentFor(p), scope: { kind: 'global' }, inputs: { 'env:local:API_TOKEN': 'synthetic' } },
      deps
    )
    expect(ok.ok).toBe(true)
    expect(readPluginSecrets('demo@market')).toEqual({ 'env:local:API_TOKEN': 'synthetic' })
    expect(
      await installPrepared(
        await prepare(await writeTree(demo()), 'x@m'),
        { consent: consentFor(p), scope: { kind: 'global' }, inputs: { unknown: 'v' } },
        deps
      )
    ).toMatchObject({ ok: false, error: 'invalid-input' })
  })

  it('updates in place: asks again when the launch line changes, keeps ids and data', async () => {
    const v1 = await prepare(await writeTree(demo(['./mcp/server.mjs'])))
    const installed = await installPrepared(v1, { consent: consentFor(v1), scope: { kind: 'global' } }, deps)
    if (!installed.ok) throw new Error('install failed')
    const keyHash = pluginKeyHash('demo@market')
    writeFileSync(path.join(deps.layout.data(keyHash), 'state.json'), '{}')
    const v2 = await prepare(
      await writeTree(demo(['./mcp/server.mjs', '--v2'], { 'skills/bye/SKILL.md': '---\ndescription: Bye\n---\nBye.' }))
    )
    v2.commit = 'c'.repeat(40)
    expect(await updatePrepared('demo@market', v2, undefined, deps)).toMatchObject({
      ok: false,
      error: 'consent-required',
    })
    const updated = await updatePrepared('demo@market', v2, consentFor(v2), deps)
    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect(updated.value.servers.local.id).toBe(installed.value.servers.local.id)
    expect(updated.value.servers.local.enabled).toBe(true)
    expect(updated.value.commit).toBe('c'.repeat(40))
    expect(updated.value.skillNames).toEqual(['demo:bye', 'demo:hello'].sort())
    expect(existsSync(deps.layout.packageDir(keyHash, installed.value.dirName))).toBe(false)
    expect(existsSync(deps.layout.packageDir(keyHash, updated.value.dirName))).toBe(true)
    expect(readFileSync(path.join(deps.layout.data(keyHash), 'state.json'), 'utf8')).toBe('{}')
    expect(deps.invalidateServer).toHaveBeenCalledWith(installed.value.servers.local.id)
    // A server that stays keeps its sign-in across updates.
    expect(deps.forgetServer).not.toHaveBeenCalledWith(installed.value.servers.local.id)
  })

  it('updates without new consent when nothing that needs consent changed', async () => {
    const v1 = await prepare(await writeTree(demo()))
    await installPrepared(v1, { consent: consentFor(v1), scope: { kind: 'global' } }, deps)
    const v2 = await prepare(await writeTree(demo(undefined, { 'README.txt': 'docs' })))
    const result = await updatePrepared('demo@market', v2, undefined, deps)
    expect(result.ok && result.value.servers.local.enabled).toBe(true)
  })

  it('uninstalls servers, skills, inputs and files, keeping data unless asked', async () => {
    const p = await prepare(await writeTree(demo()))
    const installed = await installPrepared(
      p,
      { consent: consentFor(p), scope: { kind: 'global' }, inputs: { 'env:local:API_TOKEN': 'x' } },
      deps
    )
    if (!installed.ok) throw new Error('install failed')
    const keyHash = pluginKeyHash('demo@market')
    expect((await uninstallPlugin('demo@market', { deleteData: false }, deps)).ok).toBe(true)
    expect(deps.invalidateServer).toHaveBeenCalledWith(installed.value.servers.local.id)
    expect(deps.invalidateServer).toHaveBeenCalledWith(installed.value.servers.remote.id)
    expect(deps.forgetServer).toHaveBeenCalledWith(installed.value.servers.remote.id)
    expect(deps.onSkillsRemoved).toHaveBeenCalledWith(['demo:hello'])
    expect(readPluginSecrets('demo@market')).toEqual({})
    expect(existsSync(deps.layout.packages(keyHash))).toBe(false)
    expect(existsSync(deps.layout.data(keyHash))).toBe(true)
    expect(listInstalled()).toEqual({})
    const again = await prepare(await writeTree(demo()))
    await installPrepared(again, { consent: consentFor(again), scope: { kind: 'global' } }, deps)
    await uninstallPlugin('demo@market', { deleteData: true }, deps)
    expect(existsSync(deps.layout.data(keyHash))).toBe(false)
  })

  it('reconciles interrupted operations and orphan directories after a crash', async () => {
    const p = await prepare(await writeTree(demo()))
    const installed = await installPrepared(p, { consent: consentFor(p), scope: { kind: 'global' } }, deps)
    if (!installed.ok) throw new Error('install failed')
    const keyHash = pluginKeyHash('demo@market')
    // An update that crashed after placing its new directory.
    mkdirSync(deps.layout.packageDir(keyHash, 'newversion00'), { recursive: true })
    writeInstalled((all) => {
      all['demo@market'] = {
        ...all['demo@market'],
        status: 'updating',
        dirName: 'newversion00',
        previous: {
          dirName: installed.value.dirName,
          commit: installed.value.commit,
          treeOid: 'b'.repeat(40),
          digest: installed.value.digest,
        },
      }
      all['half@market'] = {
        ...all['demo@market'],
        key: 'half@market',
        name: 'half',
        status: 'installing',
        previous: null,
      }
      all['gone@market'] = { ...installed.value, key: 'gone@market', name: 'gone', status: 'removing' }
    })
    writePluginSecrets('half@market', { a: 'b' })
    mkdirSync(path.join(base, 'packages', 'orphanhash'), { recursive: true })
    const oldStaging = path.join(deps.layout.staging(), 'old')
    mkdirSync(oldStaging, { recursive: true })
    utimesSync(oldStaging, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000))
    const report = await reconcilePlugins(deps)
    expect(report.finishedRemovals).toEqual(['gone@market'])
    expect(report.rolledBack.sort()).toEqual(['demo@market', 'half@market'])
    const records = listInstalled()
    expect(Object.keys(records)).toEqual(['demo@market'])
    expect(records['demo@market']).toMatchObject({ status: 'ready', dirName: installed.value.dirName, previous: null })
    expect(existsSync(deps.layout.packageDir(keyHash, 'newversion00'))).toBe(false)
    expect(existsSync(deps.layout.packageDir(keyHash, installed.value.dirName))).toBe(true)
    expect(existsSync(path.join(base, 'packages', 'orphanhash'))).toBe(false)
    expect(existsSync(oldStaging)).toBe(false)
    expect(readPluginSecrets('half@market')).toEqual({})
  })
})
