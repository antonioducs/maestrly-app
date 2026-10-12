import { describe, expect, it } from 'vitest'
import { normalizeGitUrl, readMarketplace } from '../../src/main/plugins/marketplace'
import { fsPackageTree } from '../../src/main/plugins/package-tree'
import { writeTree } from '../helpers/plugin-fixtures'

const j = (value: unknown) => JSON.stringify(value)
const SHA = 'a'.repeat(40)

describe('Codex marketplaces', () => {
  it('parses local, url and git-subdir sources and flags npm as unsupported', async () => {
    const root = await writeTree({
      '.agents/plugins/marketplace.json': j({
        name: 'fixture-market',
        interface: { displayName: 'Fixture Market' },
        plugins: [
          {
            name: 'local',
            source: { source: 'local', path: './plugins/local' },
            policy: { installation: 'AVAILABLE', authentication: 'ON_USE', products: ['CODEX'] },
            category: 'Coding',
          },
          { name: 'remote', source: { source: 'url', url: 'https://github.com/example/remote.git', ref: 'v1' } },
          {
            name: 'sub',
            source: { source: 'git-subdir', url: 'https://github.com/example/mono.git', path: 'pkgs/sub', sha: SHA },
          },
          { name: 'npmish', source: { source: 'npm', package: '@x/y' } },
          { name: 'plain', source: './plugins/plain' },
        ],
      }),
    })
    const market = await readMarketplace(await fsPackageTree(root), [''])
    expect(market).toMatchObject({ name: 'fixture-market', displayName: 'Fixture Market', format: 'codex', root: '' })
    const byName = Object.fromEntries(market!.entries.map((e) => [e.name, e]))
    expect(byName.local).toMatchObject({
      source: { kind: 'path', path: 'plugins/local' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_USE', products: ['CODEX'] },
      category: 'Coding',
    })
    expect(byName.remote.source).toEqual({
      kind: 'git',
      url: 'https://github.com/example/remote.git',
      ref: 'v1',
      sha: null,
      path: null,
    })
    expect(byName.sub.source).toEqual({
      kind: 'git',
      url: 'https://github.com/example/mono.git',
      ref: null,
      sha: SHA,
      path: 'pkgs/sub',
    })
    expect(byName.npmish.source).toEqual({ kind: 'unsupported', type: 'npm' })
    expect(byName.plain.source).toEqual({ kind: 'path', path: 'plugins/plain' })
    expect(byName.remote.policy).toEqual({ installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: [] })
  })

  it('merges the API marketplace by name with the first entry winning', async () => {
    const root = await writeTree({
      '.agents/plugins/marketplace.json': j({ name: 'm', plugins: [{ name: 'a', source: './a', category: 'First' }] }),
      '.agents/plugins/api_marketplace.json': j({
        name: 'm-api',
        plugins: [
          { name: 'a', source: './a', category: 'Second' },
          { name: 'b', source: './b' },
        ],
      }),
    })
    const market = await readMarketplace(await fsPackageTree(root), [''])
    expect(market!.entries.map((e) => `${e.name}:${e.category}`)).toEqual(['a:First', 'b:null'])
  })

  it('rejects escaping paths, invalid shas, bad URLs and duplicate names', async () => {
    const root = await writeTree({
      '.agents/plugins/marketplace.json': j({
        name: 'm',
        plugins: [
          { name: 'escape', source: './../x' },
          { name: 'badsha', source: { source: 'url', url: 'https://example.com/r.git', sha: 'abc' } },
          { name: 'badurl', source: { source: 'url', url: 'git@github.com:a/b.git' } },
          { name: 'dup', source: './one' },
          { name: 'dup', source: './two' },
        ],
      }),
    })
    const market = await readMarketplace(await fsPackageTree(root), [''])
    expect(market!.entries.map((e) => e.name)).toEqual(['dup'])
    expect(market!.entries[0].source).toEqual({ kind: 'path', path: 'one' })
    expect(market!.issues).toHaveLength(4)
  })
})

describe('Claude marketplaces', () => {
  it('resolves pluginRoot bare names, github sources and unsupported types', async () => {
    const root = await writeTree({
      '.claude-plugin/marketplace.json': j({
        name: 'claude-market',
        owner: { name: 'Fixture' },
        metadata: { pluginRoot: './plugins' },
        plugins: [
          { name: 'formatter', source: 'formatter', description: 'Formats', version: '1.0.0', strict: false },
          { name: 'rel', source: './tools/rel', displayName: 'Rel Tool' },
          { name: 'gh', source: { source: 'github', repo: 'example/gh-plugin', ref: 'main' } },
          { name: 'cmd', source: { source: 'command', command: 'tool path' } },
          { name: 'arch', source: { source: 'archive', url: 'https://x.example.com/a.zip' } },
        ],
      }),
    })
    const market = await readMarketplace(await fsPackageTree(root), [''])
    expect(market).toMatchObject({ name: 'claude-market', format: 'claude' })
    const byName = Object.fromEntries(market!.entries.map((e) => [e.name, e]))
    expect(byName.formatter.source).toEqual({ kind: 'path', path: 'plugins/formatter' })
    expect(byName.formatter.claude).toEqual({ strict: false, fields: { description: 'Formats', version: '1.0.0' } })
    expect(byName.formatter.display).toEqual({ description: 'Formats', version: '1.0.0' })
    expect(byName.rel).toMatchObject({
      source: { kind: 'path', path: 'tools/rel' },
      display: { displayName: 'Rel Tool' },
    })
    expect(byName.gh.source).toEqual({
      kind: 'git',
      url: 'https://github.com/example/gh-plugin.git',
      ref: 'main',
      sha: null,
      path: null,
    })
    expect(byName.cmd.source).toEqual({ kind: 'unsupported', type: 'command' })
    expect(byName.arch.source).toEqual({ kind: 'unsupported', type: 'archive' })
    expect(byName.gh.policy).toEqual({ installation: 'AVAILABLE', authentication: null, products: [] })
  })
})

describe('sources without a marketplace file', () => {
  it('treats a root plugin manifest as a single-plugin source', async () => {
    const root = await writeTree({ '.codex-plugin/plugin.json': j({ name: 'solo' }), 'skills/a/SKILL.md': 'x' })
    const market = await readMarketplace(await fsPackageTree(root), [''], { fallbackName: 'example-solo' })
    expect(market).toMatchObject({ name: 'example-solo', format: 'single-plugin', root: '' })
    expect(market!.entries).toEqual([expect.objectContaining({ name: 'solo', source: { kind: 'path', path: '' } })])
  })

  it('tries sparse paths in order and returns null when nothing is found', async () => {
    const root = await writeTree({
      'packs/one/.claude-plugin/marketplace.json': j({
        name: 'one',
        owner: { name: 'x' },
        plugins: [{ name: 'p', source: './p' }],
      }),
      'docs/readme.txt': 'nothing here',
    })
    const tree = await fsPackageTree(root)
    const market = await readMarketplace(tree, ['docs', 'packs/one'])
    expect(market).toMatchObject({ name: 'one', root: 'packs/one' })
    expect(market!.entries[0].source).toEqual({ kind: 'path', path: 'packs/one/p' })
    expect(await readMarketplace(tree, ['docs'])).toBeNull()
  })
})

describe('normalizeGitUrl', () => {
  it.each([
    ['openai/plugins', 'https://github.com/openai/plugins.git'],
    ['https://github.com/openai/plugins', 'https://github.com/openai/plugins'],
    ['https://gitlab.example.com/group/repo.git', 'https://gitlab.example.com/group/repo.git'],
  ])('accepts %s', (input, output) => {
    expect(normalizeGitUrl(input)).toBe(output)
  })
  it.each([
    'https://u:p@github.com/a/b',
    'http://github.com/a/b',
    'git@github.com:a/b.git',
    'ssh://github.com/a/b',
    'file:///tmp/x',
    'ext::sh -c x',
    'not a url',
    'https://github.com/a/b#frag',
  ])('rejects %s', (input) => {
    expect(normalizeGitUrl(input)).toBeNull()
  })
})
