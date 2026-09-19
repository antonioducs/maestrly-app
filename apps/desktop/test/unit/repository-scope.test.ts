import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import {
  createRepositoryScope,
  RepositoryScopeError,
  SINGLE_REPOSITORY_SELECTOR,
} from '../../src/main/repository-scope'
import { createConversationFileScope } from '../../src/main/conversation-file-scope'
import type { Conversation } from '../../src/main/store/conversations'

const temporary: string[] = []
async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestrly-repo-scope-'))
  temporary.push(dir)
  return dir
}
const conversation = (fields: Partial<Conversation>) => ({ isMulti: 0, cwd: '', ...fields }) as Conversation

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('repository scope', () => {
  it('does not expose the standalone files directory as a repository', async () => {
    const scope = await createRepositoryScope(conversation({ scope: 'standalone', cwd: await tempDir(), branch: null, workspaceId: null, mode: null }))
    expect(scope.repositories).toEqual([])
    expect(() => scope.resolveRepository()).toThrowError(/no repository/i)
    await expect(scope.resolveBridgePath('notes.txt')).rejects.toMatchObject({ code: 'no_repository' })
  })

  it('maps multi linkName directly to persisted worktrees and requires selection', async () => {
    const base = await tempDir()
    const backend = path.join(base, 'backend-worktree')
    const frontend = path.join(base, 'frontend-worktree')
    await Promise.all([fs.mkdir(backend), fs.mkdir(frontend)])
    const scope = await createRepositoryScope(
      conversation({
        cwd: path.join(base, 'aggregator'),
        isMulti: 1,
        repos: [
          {
            workspaceId: 'w',
            repoTop: '/unused/a',
            branch: 'b',
            base: 'main',
            worktreePath: backend,
            linkName: 'backend',
          },
          {
            workspaceId: 'w',
            repoTop: '/unused/b',
            branch: 'b',
            base: 'main',
            worktreePath: frontend,
            linkName: 'frontend',
          },
        ],
      })
    )

    expect(() => scope.resolveRepository()).toThrowError(RepositoryScopeError)
    expect(scope.resolveRepository('frontend').realWorktreePath).toBe(await fs.realpath(frontend))
    expect(() => scope.resolveRepository('../backend')).toThrowError(/list_external_capabilities \(backend, frontend\)/)
    expect(() => scope.resolveRepository(SINGLE_REPOSITORY_SELECTOR)).toThrowError(/not owner\/repo/)

    await expect(
      createRepositoryScope(
        conversation({
          isMulti: 1,
          repos: [
            { workspaceId: 'w', repoTop: backend, branch: 'b', base: 'main', worktreePath: backend, linkName: '' },
          ],
        })
      )
    ).rejects.toMatchObject({ code: 'no_repository' })
  })

  it('rejects lexical traversal and realpath escapes through symlinks', async () => {
    const base = await tempDir()
    const root = path.join(base, 'repo')
    const outside = path.join(base, 'secret')
    await Promise.all([fs.mkdir(root), fs.mkdir(outside)])
    await fs.writeFile(path.join(outside, 'token'), 'secret')
    await fs.symlink(outside, path.join(root, 'escape'), 'dir')
    const scope = await createRepositoryScope(conversation({ cwd: root }))

    await expect(scope.resolvePath(undefined, '../secret/token')).rejects.toMatchObject({ code: 'path_escape' })
    await expect(scope.resolvePath(undefined, 'escape/token')).rejects.toMatchObject({ code: 'path_escape' })
    await expect(scope.resolvePath(undefined, 'new/nested.txt')).resolves.toMatchObject({
      relativePath: path.join('new', 'nested.txt'),
    })
  })

  it('accepts the public single-repository selector advertised to external readers', async () => {
    const root = await tempDir()
    const scope = await createRepositoryScope(conversation({ cwd: root }))

    expect(scope.resolveRepository(SINGLE_REPOSITORY_SELECTOR)).toBe(scope.repositories[0])
    expect(() => scope.resolveRepository('owner/repo')).toThrowError(
      /list_external_capabilities \(repository\).*not owner\/repo.*use "repository" or omit repo/
    )
  })

  it('returns a canonical target that cannot be redirected by replacing an in-repo symlink', async () => {
    const base = await tempDir()
    const root = path.join(base, 'repo')
    const inside = path.join(root, 'real')
    const outside = path.join(base, 'outside')
    const link = path.join(root, 'linked')
    await Promise.all([fs.mkdir(inside, { recursive: true }), fs.mkdir(outside)])
    await fs.writeFile(path.join(inside, 'target.txt'), 'validated\n')
    await fs.writeFile(path.join(outside, 'target.txt'), 'redirected\n')
    await fs.symlink(inside, link, 'dir')
    const scope = await createRepositoryScope(conversation({ cwd: root }))

    const resolved = await scope.resolvePath(undefined, 'linked/target.txt')
    expect(resolved.relativePath).toBe(path.join('linked', 'target.txt'))
    expect(resolved.absolutePath).toBe(path.join(await fs.realpath(inside), 'target.txt'))

    await fs.rm(link)
    await fs.symlink(outside, link, 'dir')

    await expect(fs.readFile(resolved.absolutePath, 'utf8')).resolves.toBe('validated\n')
  })
})


it('jails standalone files including symlinks and missing targets', async () => {
  const base = await fs.realpath(await tempDir())
  vi.spyOn(app, 'getPath').mockReturnValue(base)
  const id = '11111111-1111-4111-8111-111111111111'
  const root = path.join(base, 'standalone-chats', id)
  await fs.mkdir(root, { recursive: true })
  const outside = await tempDir()
  await fs.symlink(outside, path.join(root, 'escape'), 'dir')
  const chat = conversation({ id, scope: 'standalone', cwd: root })
  const scope = await createConversationFileScope(chat)
  await expect(createConversationFileScope({ ...chat, cwd: outside })).rejects.toThrow('Unsafe standalone')
  await expect(scope.resolveBridgePath('escape/missing/file')).rejects.toMatchObject({ code: 'path_escape' })
  await expect(scope.resolveBridgePath('../outside')).rejects.toMatchObject({ code: 'path_escape' })
  await expect(scope.resolveBridgePath('/absolute')).rejects.toMatchObject({ code: 'invalid_path' })
  // displayPath keeps the platform separator, like the project scope above.
  await expect(scope.resolveBridgePath('new/file')).resolves.toMatchObject({
    displayPath: path.join('new', 'file'),
  })
  await fs.rm(root, { recursive: true })
  await fs.symlink(outside, root, 'dir')
  await expect(scope.resolveBridgePath('file')).rejects.toThrow('Unsafe standalone')
})
