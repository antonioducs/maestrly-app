import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gitRead } from '../../src/main/git-read'
import {
  createRepositoryScope,
  SINGLE_REPOSITORY_SELECTOR,
  type RepositoryScope,
} from '../../src/main/repository-scope'
import type { Conversation } from '../../src/main/store/conversations'

const exec = promisify(execFile)
let root: string
let scope: RepositoryScope

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'maestrly-git-read-'))
  await exec('git', ['init', '-b', 'main'], { cwd: root })
  await exec('git', ['config', 'user.name', 'Test'], { cwd: root })
  await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  await fs.writeFile(path.join(root, 'hello.txt'), 'hello\nworld\n')
  await exec('git', ['add', 'hello.txt'], { cwd: root })
  await exec('git', ['commit', '-m', 'initial'], { cwd: root })
  scope = await createRepositoryScope({ cwd: root, isMulti: 0 } as Conversation)
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('gitRead', () => {
  it('returns structured data for the allowlisted operations', async () => {
    await fs.appendFile(path.join(root, 'hello.txt'), 'changed\n')
    const capabilityPayload = {
      repositories: scope.repositories.map((repository) => ({
        id: repository.linkName || SINGLE_REPOSITORY_SELECTOR,
        name: repository.linkName || SINGLE_REPOSITORY_SELECTOR,
      })),
    }
    const status = await gitRead(scope, {
      operation: 'status',
      repo: capabilityPayload.repositories[0].id,
    })
    const log = await gitRead(scope, { operation: 'log', limit: 1 })
    const branches = await gitRead(scope, { operation: 'branches' })
    const files = await gitRead(scope, { operation: 'ls-files' })
    expect(status.data).toMatchObject({ entries: [expect.stringContaining('hello.txt')] })
    expect(log.data).toMatchObject({ commits: [{ subject: 'initial' }] })
    expect(branches.data).toEqual({ branches: ['main'] })
    expect(files.data).toEqual({ files: ['hello.txt'] })
  })

  it('includes newly created files in the complete diff', async () => {
    const created = path.join(root, 'created.ts')
    await fs.writeFile(created, 'export const created = true\n')
    try {
      const result = await gitRead(scope, { operation: 'diff', ref: 'HEAD' })
      expect(result.data).toMatchObject({
        text: expect.stringContaining('diff --git a/created.ts b/created.ts'),
      })
      expect((result.data as { text: string }).text).toContain('+export const created = true')
    } finally {
      await fs.rm(created, { force: true })
    }
  })

  it('rejects option-shaped refs and symlink path escapes', async () => {
    await expect(gitRead(scope, { operation: 'show', ref: '--help' })).rejects.toThrow(/Invalid Git ref/)
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'maestrly-git-outside-'))
    await fs.symlink(outside, path.join(root, 'outside'), 'dir')
    await expect(gitRead(scope, { operation: 'ls-files', path: 'outside/file' })).rejects.toMatchObject({
      code: 'path_escape',
    })
    await fs.rm(outside, { recursive: true, force: true })
  })
})
