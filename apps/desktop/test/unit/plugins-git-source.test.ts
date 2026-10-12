import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PluginGitSource,
  type SpawnGitOptions,
  sparsePattern,
  spawnHardenedGit,
} from '../../src/main/plugins/git-source'
import { commitFiles, makeGitRepo } from '../helpers/plugin-fixtures'

const work = () => mkdtempSync(path.join(os.tmpdir(), 'plg-git-'))

describe('plugin Git source', () => {
  it('fetches a ref, lists modes and sparse-checks out only requested files', async () => {
    const repo = await makeGitRepo(
      {
        'p/plugin.json': '{}',
        'p/skills/a/SKILL.md': 'x',
        'p/big.bin': 'y',
        'p/run.sh': { content: '#!/bin/sh', mode: 0o755 },
        'p/link': { symlink: '../outside' },
      },
      { submodule: 'p/sub' }
    )
    const git = new PluginGitSource({ allowFileRoot: path.dirname(repo.dir) })
    const dir = work()
    const commit = await git.fetch(dir, { url: pathToFileURL(repo.dir).href, ref: null, sha: null })
    expect(commit).toBe(repo.commit)
    const entries = await git.listTree(dir, commit, 'p')
    expect(entries).toEqual(
      expect.arrayContaining([
        { path: 'p/run.sh', mode: 'executable' },
        { path: 'p/link', mode: 'symlink' },
        { path: 'p/sub', mode: 'submodule' },
        { path: 'p/plugin.json', mode: 'file' },
      ])
    )
    await git.checkout(dir, commit, ['/p/plugin.json', '/p/skills/*/SKILL.md'])
    expect(existsSync(path.join(dir, 'p/plugin.json'))).toBe(true)
    expect(existsSync(path.join(dir, 'p/skills/a/SKILL.md'))).toBe(true)
    expect(existsSync(path.join(dir, 'p/big.bin'))).toBe(false)
    // Widening the sparse set materializes more files at the same commit.
    await git.checkout(dir, commit, ['/p/'])
    expect(readFileSync(path.join(dir, 'p/big.bin'), 'utf8')).toBe('y')
    expect(await git.treeOid(dir, commit, 'p')).toMatch(/^[0-9a-f]{40}$/)
    expect(await git.treeOid(dir, commit, 'missing')).toBeNull()
  })

  it('pins a commit and moves to a newer ref on refetch', async () => {
    const repo = await makeGitRepo({ 'a.txt': 'one' })
    const second = await commitFiles(repo.dir, { 'a.txt': 'two' })
    const git = new PluginGitSource({ allowFileRoot: path.dirname(repo.dir) })
    const dir = work()
    const url = pathToFileURL(repo.dir).href
    expect(await git.fetch(dir, { url, ref: 'main', sha: null })).toBe(second)
    expect(await git.fetch(dir, { url, ref: null, sha: repo.commit })).toBe(repo.commit)
    await git.checkout(dir, repo.commit, ['/a.txt'])
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('one')
  })

  it.each([
    'http://example.com/r.git',
    'git@github.com:a/b.git',
    'ssh://example.com/r',
    'https://u:p@example.com/r',
    'ext::sh -c x',
    'file:///etc',
  ])('rejects %s', (u) => {
    expect(() => new PluginGitSource({ allowFileRoot: null }).checkUrl(u)).toThrow(
      expect.objectContaining({ code: 'invalid-url' })
    )
  })

  it('rejects file URLs outside the allowed root', () => {
    const root = work()
    expect(() => new PluginGitSource({ allowFileRoot: root }).checkUrl('file:///etc')).toThrow(
      expect.objectContaining({ code: 'invalid-url' })
    )
    expect(new PluginGitSource({ allowFileRoot: root }).checkUrl(pathToFileURL(path.join(root, 'x')).href)).toBe(
      pathToFileURL(path.join(root, 'x')).href
    )
  })

  it('rejects refs that look like options', async () => {
    const git = new PluginGitSource({ allowFileRoot: null })
    await expect(
      git.fetch(work(), { url: 'https://example.com/r.git', ref: '--upload-pack=x', sha: null })
    ).rejects.toMatchObject({ code: 'invalid-url' })
    await expect(git.fetch(work(), { url: 'https://example.com/r.git', ref: null, sha: 'abc' })).rejects.toMatchObject({
      code: 'invalid-url',
    })
  })

  it('never prompts for credentials and ignores user configuration', async () => {
    const repo = await makeGitRepo({ 'a.txt': 'x' })
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = []
    const git = new PluginGitSource({
      allowFileRoot: path.dirname(repo.dir),
      spawnGit: (args: readonly string[], opts: SpawnGitOptions) => {
        calls.push({ args: [...args], env: opts.env })
        return spawnHardenedGit(args, opts)
      },
    })
    await git.fetch(work(), { url: pathToFileURL(repo.dir).href, ref: null, sha: repo.commit })
    expect(calls.length).toBeGreaterThan(0)
    expect(
      calls.every(
        (c) =>
          c.args.includes('credential.helper=') &&
          c.args.includes('protocol.allow=never') &&
          c.args.includes('core.symlinks=false') &&
          c.env.GIT_TERMINAL_PROMPT === '0' &&
          c.env.GIT_CONFIG_NOSYSTEM === '1' &&
          !!c.env.GIT_CONFIG_GLOBAL &&
          !!c.env.GIT_ASKPASS
      )
    ).toBe(true)
    // Without an allowed file root, only HTTPS is enabled.
    const strict = new PluginGitSource({
      allowFileRoot: null,
      spawnGit: async (args) => {
        calls.push({ args: [...args], env: {} })
        return { code: 0, stdout: Buffer.from('git version 2.0.0\n'), stderr: '' }
      },
    })
    await strict.gitVersion()
    expect(calls.at(-1)!.args).not.toContain('protocol.file.allow=always')
  })

  it('classifies a missing repository and aborts on signal', async () => {
    const parent = work()
    const git = new PluginGitSource({ allowFileRoot: parent })
    await expect(
      git.fetch(work(), { url: pathToFileURL(path.join(parent, 'missing')).href, ref: null, sha: null })
    ).rejects.toMatchObject({ code: 'not-found' })
    const controller = new AbortController()
    controller.abort()
    await expect(
      spawnHardenedGit(['--version'], {
        cwd: os.tmpdir(),
        env: process.env,
        signal: controller.signal,
        timeoutMs: 1000,
      })
    ).rejects.toMatchObject({ code: 'timeout' })
  })

  it('escapes glob characters in sparse patterns', () => {
    expect(sparsePattern('plugins/a*b', '/')).toBe('/plugins/a\\*b/')
    expect(sparsePattern('!x/#y')).toBe('/\\!x/\\#y')
  })
})
