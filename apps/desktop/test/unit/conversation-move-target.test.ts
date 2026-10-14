import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachmentConversationDir } from '../../src/main/chat/attachment-artifacts'
import { getMoveEndpoint } from '../../src/main/conversation-move/endpoint-store'
import { removeRestoredConversationFiles } from '../../src/main/conversation-move/files'
import { __resetMoveLeasesForTests } from '../../src/main/conversation-move/leases'
import { exportSource, freezeSource, inspectSource } from '../../src/main/conversation-move/source'
import {
  commitTarget,
  discardTarget,
  importTarget,
  inspectTarget,
  prepareTargetWorkspace,
  type TargetDeps,
  verifyTarget,
} from '../../src/main/conversation-move/target'
import {
  __resetCwdActivityForTests,
  cwdLeaseOwner,
  tryAcquireCwdActivity,
} from '../../src/main/cwd-activity-coordinator'
import { createWorktree } from '../../src/main/git-service'
import { createProjectSetupService } from '../../src/main/project-setup/service'
import { setProjectsDirectory } from '../../src/main/projects-directory'
import { getConversation, getDb, listWorkspaces } from '../../src/main/store'
import type { ExportedPackage, MoveTargetPlan, SourceInspection } from '../../src/shared/conversation-move'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { dirty, git, type MoveRepo, makeRemoteRepo, status } from '../helpers/move-repo'

const OP = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
let repo: MoveRepo
let projects: string
let source: SourceInspection
let exported: ExportedPackage
let packagePath: string
let sourceStatus: string
let deps: TargetDeps

beforeEach(async () => {
  // A host's environment would stage moves in its roots instead of this test profile.
  vi.stubEnv('MAESTRLY_SERVER_MODE', '')
  freshDb()
  repo = makeRemoteRepo('maestrly-move-target-')
  git(repo.work, 'checkout', '-q', 'main')
  const cwd = await createWorktree({
    top: repo.work,
    branch: 'feat',
    base: 'main',
    isNewBranch: false,
    dest: path.join(repo.root, 'wt-feat'),
  })
  dirty(cwd)
  await mkdir(path.join(cwd, '.agents/notes'), { recursive: true })
  await writeFile(path.join(cwd, '.agents/notes/p1.md'), '# Plan\n')
  const ws = makeWorkspace({ path: repo.work })
  const conv = makeConversation(ws.id, { cwd, branch: 'feat', mode: 'worktree', name: 'Feature' })
  const insert = getDb().prepare(
    'INSERT INTO chat_messages (id, conversation_id, role, parts_json, seq, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
  for (const seq of [1, 2]) insert.run(`m${seq}-${conv.id}`, conv.id, seq === 1 ? 'user' : 'assistant', '[]', seq, seq)
  await mkdir(attachmentConversationDir(conv.id), { recursive: true })
  await writeFile(path.join(attachmentConversationDir(conv.id), 'a1.png'), Buffer.from([1, 2, 3]))
  sourceStatus = status(cwd)

  const sourceDeps = { quiesce: vi.fn(async () => ({ ok: true, failed: [] })), appVersion: () => '1.0.0' }
  source = await inspectSource({ conversationId: conv.id })
  await freezeSource({ operationId: OP, conversationId: conv.id, fingerprint: source.fingerprint }, sourceDeps)
  const pkg = await exportSource({ operationId: OP, selectedIgnoredPaths: [], confirmedSensitivePaths: [] }, sourceDeps)
  packagePath = path.join(repo.root, pkg.name)
  await copyFile(pkg.path, packagePath)
  exported = { ...pkg, path: packagePath }

  // Another host: its own database, profile files and projects folder.
  __resetMoveLeasesForTests()
  __resetCwdActivityForTests()
  await removeRestoredConversationFiles(conv.id)
  closeDb()
  freshDb()
  projects = path.join(repo.root, 'projects')
  await mkdir(projects)
  await setProjectsDirectory(projects)
  deps = { appVersion: () => '1.0.0', setup: createProjectSetupService() }
})

afterEach(async () => {
  vi.unstubAllEnvs()
  __resetMoveLeasesForTests()
  __resetCwdActivityForTests()
  await removeRestoredConversationFiles(source.conversationId)
  closeDb()
  repo.cleanup()
})

const inspection = (overrides: Partial<{ branch: string }> = {}) =>
  inspectTarget({
    conversationId: source.conversationId,
    remoteUrl: source.remoteUrl!,
    defaultBranch: source.defaultBranch,
    branch: overrides.branch ?? 'feat',
    headOid: source.headOid,
  })

async function prepareClone(): Promise<{ workspaceId: string; plan: MoveTargetPlan }> {
  const { workspace } = await inspection()
  const { workspaceId } = await prepareTargetWorkspace(
    { operationId: OP, conversationId: source.conversationId, workspace: workspace! },
    deps
  )
  return { workspaceId, plan: { workspace: workspace!, branch: 'feat', branchAction: 'create' } }
}

describe('conversation move target', () => {
  it('plans a clone when no workspace shares the remote', async () => {
    const result = await inspection()
    expect(result.blockers).toEqual([])
    expect(result.workspace).toEqual({
      kind: 'clone',
      parentPath: projects,
      name: 'remote',
      remoteUrl: repo.remote,
      defaultBranch: 'main',
    })
    expect(result.branch).toMatchObject({
      name: 'feat',
      state: 'absent',
      ancestor: null,
      freeAlternative: 'feat-moved',
    })
    expect((await inspection({ branch: 'main' })).branch.state).toBe('checked-out')
    expect((await inspection({ branch: 'bad..name' })).blockers.map((b) => b.code)).toEqual(['target-branch-invalid'])
  })

  it('matches an existing workspace by origin in another URL form', async () => {
    const other = repo.clone('other')
    // Another spelling of the same remote. A Windows path is no file URL, so there only the suffixes differ.
    const spelled = process.platform === 'win32' ? `${repo.remote.replace(/\.git$/, '')}/` : `file://${repo.remote}/`
    git(other, 'remote', 'set-url', 'origin', spelled)
    const ws = makeWorkspace({ path: other, name: 'other' })
    expect((await inspection()).workspace).toEqual({ kind: 'existing', workspaceId: ws.id, name: 'other', path: other })
  })

  it('adopts an unregistered folder with the same remote and refuses another remote', async () => {
    git(projects, 'clone', '-q', repo.remote, 'remote')
    expect((await inspection()).workspace).toEqual({
      kind: 'adopt',
      path: path.join(projects, 'remote'),
      name: 'remote',
    })
    git(path.join(projects, 'remote'), 'remote', 'set-url', 'origin', 'https://example.com/someone/else.git')
    const refused = await inspection()
    expect(refused.workspace).toBeNull()
    expect(refused.blockers.map((blocker) => blocker.code)).toEqual(['clone-destination-exists'])
  })

  it('blocks without projects directory and when the conversation already exists', async () => {
    await setProjectsDirectory(null)
    expect((await inspection()).blockers.map((blocker) => blocker.code)).toEqual(['projects-directory-missing'])
    const ws = makeWorkspace()
    makeConversation(ws.id, { id: source.conversationId })
    expect((await inspection()).blockers.map((blocker) => blocker.code)).toContain('target-has-conversation')
  })

  it('reports branch states and a free alternative', async () => {
    const other = repo.clone('other')
    makeWorkspace({ path: other })
    // Without the source's HEAD, the destination cannot tell ancestry.
    git(other, 'branch', 'feat', 'origin/main')
    expect((await inspection()).branch).toMatchObject({ state: 'exists', ancestor: null })
    git(repo.work, 'push', '-q', 'origin', 'feat')
    git(other, 'fetch', '-q', 'origin')
    expect((await inspection()).branch).toMatchObject({ state: 'exists', ancestor: true })
    git(other, 'branch', '-f', 'feat', 'origin/feat')
    expect((await inspection()).branch).toMatchObject({ state: 'same', tipOid: source.headOid })
    git(other, 'checkout', '-q', 'feat')
    git(other, 'commit', '-q', '--allow-empty', '-m', 'diverge')
    git(other, 'checkout', '-q', 'main')
    git(other, 'branch', 'feat-moved')
    expect((await inspection()).branch).toMatchObject({
      state: 'exists',
      ancestor: false,
      freeAlternative: 'feat-moved-2',
    })
    git(other, 'worktree', 'add', '-q', path.join(repo.root, 'busy'), 'feat')
    expect((await inspection()).branch.state).toBe('checked-out')
  })

  it('clones once and reuses the workspace on retry', async () => {
    const progress: string[] = []
    deps.onProgress = (event) => progress.push(event.phase ?? '')
    const first = await prepareClone()
    expect(listWorkspaces().map((workspace) => workspace.path)).toEqual([path.join(projects, 'remote')])
    expect(progress).toContain('completed')
    const again = await prepareClone()
    expect(again.workspaceId).toBe(first.workspaceId)
    expect(listWorkspaces()).toHaveLength(1)
    expect(getMoveEndpoint(OP, 'target')).toMatchObject({ state: 'workspace-ready', data: { cloned: true } })
  })

  it('imports the conversation with its worktree, files and rows, and holds it until commit', async () => {
    const { workspaceId, plan } = await prepareClone()
    const imported = await importTarget(
      { operationId: OP, packagePath, sha256: exported.sha256, workspaceId, plan },
      deps
    )
    expect(getConversation(imported.conversationId)).toMatchObject({ cwd: imported.cwd, branch: 'feat', workspaceId })
    expect(tryAcquireCwdActivity(imported.cwd, 'chat')).toBeNull()
    expect(status(imported.cwd)).toBe(sourceStatus)
    expect(await readFile(path.join(imported.cwd, '.agents/notes/p1.md'), 'utf8')).toBe('# Plan\n')
    expect(await readFile(path.join(attachmentConversationDir(imported.conversationId), 'a1.png'))).toEqual(
      Buffer.from([1, 2, 3])
    )
    expect(await verifyTarget({ operationId: OP })).toEqual(exported.digest)
    // Importing again returns what was imported.
    await expect(
      importTarget({ operationId: OP, packagePath, sha256: exported.sha256, workspaceId, plan }, deps)
    ).resolves.toEqual(imported)
    await commitTarget({ operationId: OP })
    expect(cwdLeaseOwner(imported.cwd)).toBeNull()
    expect(tryAcquireCwdActivity(imported.cwd, 'chat')).not.toBeNull()
    expect(git(path.join(projects, 'remote'), 'for-each-ref', `refs/maestrly/incoming/${OP}`)).toBe('')
    await expect(discardTarget({ operationId: OP })).rejects.toMatchObject({ code: 'stale' })
    await rm(imported.cwd, { recursive: true, force: true })
  })

  it('discards an import: conversation, worktree and created branch go, the workspace stays', async () => {
    const { workspaceId, plan } = await prepareClone()
    const imported = await importTarget(
      { operationId: OP, packagePath, sha256: exported.sha256, workspaceId, plan },
      deps
    )
    await discardTarget({ operationId: OP })
    expect(getConversation(imported.conversationId)).toBeUndefined()
    await expect(access(imported.cwd)).rejects.toThrow()
    await expect(access(attachmentConversationDir(imported.conversationId))).rejects.toThrow()
    expect(git(path.join(projects, 'remote'), 'branch', '--list', 'feat')).toBe('')
    expect(listWorkspaces().map((workspace) => workspace.id)).toEqual([workspaceId])
    expect(cwdLeaseOwner(imported.cwd)).toBeNull()
    expect(getMoveEndpoint(OP, 'target')?.state).toBe('discarded')
    await discardTarget({ operationId: OP })
  })

  it('rejects a package whose hash differs without creating anything', async () => {
    const { workspaceId, plan } = await prepareClone()
    await expect(
      importTarget({ operationId: OP, packagePath, sha256: 'f'.repeat(64), workspaceId, plan }, deps)
    ).rejects.toMatchObject({ code: 'package-invalid' })
    expect(getConversation(source.conversationId)).toBeUndefined()
    expect(git(path.join(projects, 'remote'), 'worktree', 'list').split('\n')).toHaveLength(1)
    expect(getMoveEndpoint(OP, 'target')?.state).toBe('workspace-ready')
  })
})
