import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const mainEntry = path.join(repoRoot, 'out', 'main', 'index.js')

interface Conversation {
  id: string
  name: string
  branch: string
  mode: 'local' | 'worktree'
  cwd: string
  archived: number
}
interface WorkspaceWithConversations {
  id: string
  conversations: Conversation[]
}
interface MigrationRecovery {
  operationId: string
  conversationId: string
  relatedConversationId?: string
  phase: string
  status: string
  sourceCwd: string
  destinationCwd: string
  stashOid?: string
  canContinue: boolean
  canRollback: boolean
  message?: string
}
interface Api {
  addWorkspace(dir: string): Promise<{ id: string }>
  listWorkspaces(includeArchived?: boolean): Promise<WorkspaceWithConversations[]>
  prepareLocalConversation(input: {
    workspaceId: string
    name?: string
    intent: { type: 'switch-existing'; branch: string; ref: { kind: 'local'; name: string } }
  }): Promise<{ status: string; token?: string }>
  confirmLocalConversation(input: { token: string }): Promise<{
    status: string
    conversation?: Conversation
  }>
  listConversationMigrationRecoveries(): Promise<MigrationRecovery[]>
  resolveConversationMigration(input: {
    operationId: string
    action: 'continue' | 'rollback'
  }): Promise<{ status: string; recovery?: MigrationRecovery }>
  chatAddProvider(input: {
    name: string
    baseURL: string
    key: string
    kind: 'openai'
  }): Promise<{ ok: boolean; id?: string; error?: string }>
  chatSetSelection(
    conversationId: string,
    selection: { providerId: string; modelId: string }
  ): Promise<{ ok: boolean; error?: string }>
  chatSend(conversationId: string, text: string): Promise<{ ok: boolean; error?: string }>
  chatHistoryPage(
    conversationId: string,
    opts?: { beforeSeq?: number; aroundSeq?: number; limit?: number }
  ): Promise<{ messages: Array<{ role: string }> }>
  getOnboardingDone(): Promise<boolean>
  setOnboardingDone(done: boolean): void
  createNotePage(scope: 'conv', id: string, args: { title: string }): Promise<{ id: string } | null>
  writeNotePage(scope: 'conv', id: string, pageId: string, content: string): Promise<void>
}
declare const window: { api: Api }

type AppWindow = Awaited<ReturnType<ElectronApplication['firstWindow']>>

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function launch(
  userData: string,
  instanceId: string,
  envOverrides: Record<string, string> = {}
): Promise<ElectronApplication> {
  return electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      AGENTS_E2E: '1',
      AGENTS_CHANNEL: 'dev',
      AGENTS_INSTANCE: instanceId,
      AGENTS_USERDATA: userData,
      AGENTS_LOCALE: 'en',
      ELECTRON_RENDERER_URL: '',
      ...envOverrides,
    },
  })
}

async function ready(win: AppWindow): Promise<void> {
  await win.waitForFunction(() => typeof window.api !== 'undefined')
  if (!(await win.evaluate(() => window.api.getOnboardingDone()))) {
    await win.evaluate(() => window.api.setOnboardingDone(true))
    const skip = win.getByRole('button', { name: 'Skip' })
    if (await skip.isVisible().catch(() => false)) await skip.click()
  }
}

function initRepo(root: string): string {
  const repo = path.join(root, 'repo')
  mkdirSync(repo)
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.name', 'E2E'])
  git(repo, ['config', 'user.email', 'e2e@test.local'])
  writeFileSync(path.join(repo, 'tracked.txt'), 'base\n')
  writeFileSync(path.join(repo, '.gitignore'), '.env.local\n')
  git(repo, ['add', 'tracked.txt', '.gitignore'])
  git(repo, ['commit', '-q', '-m', 'init'])
  return repo
}

async function createLocalConversation(win: AppWindow, repo: string, name: string): Promise<Conversation> {
  const result = await win.evaluate(
    async ({ repoDir, conversationName }) => {
      const workspace = await window.api.addWorkspace(repoDir)
      const prepared = await window.api.prepareLocalConversation({
        workspaceId: workspace.id,
        name: conversationName,
        intent: {
          type: 'switch-existing',
          branch: 'main',
          ref: { kind: 'local', name: 'main' },
        },
      })
      if (prepared.status !== 'ready' || !prepared.token) return { error: prepared.status }
      const confirmed = await window.api.confirmLocalConversation({ token: prepared.token })
      if (confirmed.status !== 'created' || !confirmed.conversation) {
        return { error: confirmed.status }
      }
      return { conversation: confirmed.conversation }
    },
    { repoDir: repo, conversationName: name }
  )
  if ('error' in result) throw new Error(`local conversation setup failed: ${result.error}`)
  return result.conversation
}

async function openMigrationDialog(win: AppWindow, conversationName: string): Promise<void> {
  const row = win.locator('li.conv-item').filter({ hasText: conversationName })
  await expect(row).toBeVisible()
  await row.click({ button: 'right' })
  await win.getByRole('menuitem', { name: 'Move to isolated branch…' }).click()
  await expect(win.getByRole('heading', { name: 'Move conversation to an isolated branch' })).toBeVisible()
}

function seedDirtyBatch(repo: string): void {
  writeFileSync(path.join(repo, 'tracked.txt'), 'staged\n')
  git(repo, ['add', 'tracked.txt'])
  writeFileSync(path.join(repo, 'tracked.txt'), 'staged\nunstaged\n')
  writeFileSync(path.join(repo, 'untracked.txt'), 'untracked\n')
  writeFileSync(path.join(repo, '.env.local'), 'TOKEN=e2e-secret\n')
}

test('direct Chat: the dialog transfers Git, notes, and ignored files and completes immediately', async () => {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'agents-e2e-migration-direct-')))
  const userData = path.join(root, 'ud')
  mkdirSync(userData)
  const repo = initRepo(root)
  let app: ElectronApplication | null = null
  try {
    app = await launch(userData, 'e2e-migration-direct')
    let win = await app.firstWindow()
    await ready(win)
    const conversation = await createLocalConversation(win, repo, 'Migration chat')
    const page = await win.evaluate(
      (conversationId) => window.api.createNotePage('conv', conversationId, { title: 'Migration note' }),
      conversation.id
    )
    expect(page).not.toBeNull()
    await win.evaluate(
      ({ conversationId, pageId }) => window.api.writeNotePage('conv', conversationId, pageId, '# context kept\n'),
      { conversationId: conversation.id, pageId: page!.id }
    )
    seedDirtyBatch(repo)
    await app.close()
    app = await launch(userData, 'e2e-migration-direct')
    win = await app.firstWindow()
    await ready(win)

    await openMigrationDialog(win, conversation.name)
    await win.getByLabel('New destination branch').fill('feature/e2e-direct')
    await win.getByRole('button', { name: 'Prepare preview' }).click()
    await expect(win.getByText('feature/e2e-direct', { exact: true })).toBeVisible()
    await expect(win.getByText('tracked.txt', { exact: true })).toHaveCount(2)
    await expect(win.getByText('untracked.txt', { exact: true })).toBeVisible()
    const ignored = win.locator('label').filter({ hasText: '.env.local' }).first()
    await ignored.getByRole('checkbox').check()
    await win
      .locator('label')
      .filter({ hasText: /I reviewed “\.env\.local”/ })
      .getByRole('checkbox')
      .check()
    await win.getByRole('button', { name: 'Move to worktree' }).click()
    await expect.poll(() => win.evaluate(() => window.api.listConversationMigrationRecoveries())).toEqual([])
    const migrated = (await win.evaluate(() => window.api.listWorkspaces(true)))
      .flatMap((workspace) => workspace.conversations)
      .find((item) => item.id === conversation.id)!
    expect(migrated).toMatchObject({ branch: 'feature/e2e-direct', mode: 'worktree' })
    expect(git(repo, ['branch', '--show-current'])).toBe('main')
    expect(git(repo, ['status', '--porcelain'])).toBe('')
    expect(git(migrated.cwd, ['status', '--porcelain'])).toContain('tracked.txt')
    expect(readFileSync(path.join(migrated.cwd, 'tracked.txt'), 'utf8')).toBe('staged\nunstaged\n')
    expect(readFileSync(path.join(migrated.cwd, 'untracked.txt'), 'utf8')).toBe('untracked\n')
    expect(readFileSync(path.join(migrated.cwd, '.env.local'), 'utf8')).toBe('TOKEN=e2e-secret\n')
    expect(readFileSync(path.join(migrated.cwd, '.agents', 'notes', `${page!.id}.md`), 'utf8')).toBe('# context kept\n')
    expect(git(repo, ['stash', 'list'])).toBe('')

    await app.close()
    app = await launch(userData, 'e2e-migration-direct')
    win = await app.firstWindow()
    await ready(win)
    expect(await win.evaluate(() => window.api.listConversationMigrationRecoveries())).toEqual([])
  } finally {
    if (app) await app.close().catch(() => {})
    // Electron helpers may briefly finish writing the profile after app.close().
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('direct Chat: new work at the destination does not reopen recovery after restart', async () => {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'agents-e2e-migration-successor-')))
  const userData = path.join(root, 'ud')
  mkdirSync(userData)
  const repo = initRepo(root)
  let app: ElectronApplication | null = null
  try {
    app = await launch(userData, 'e2e-migration-rollback')
    let win = await app.firstWindow()
    await ready(win)
    const original = await createLocalConversation(win, repo, 'Migration rollback')
    writeFileSync(path.join(repo, 'tracked.txt'), 'successor change\n')
    await app.close()
    app = await launch(userData, 'e2e-migration-rollback')
    win = await app.firstWindow()
    await ready(win)

    await openMigrationDialog(win, 'Migration rollback')
    await win.getByLabel('New destination branch').fill('feature/e2e-rollback')
    await win.getByRole('button', { name: 'Prepare preview' }).click()
    await expect(win.getByText('feature/e2e-rollback', { exact: true })).toBeVisible()
    await win.getByRole('button', { name: 'Move to worktree' }).click()
    await expect.poll(() => win.evaluate(() => window.api.listConversationMigrationRecoveries())).toEqual([])
    const conversations = (await win.evaluate(() => window.api.listWorkspaces(true))).flatMap(
      (workspace) => workspace.conversations
    )
    const migrated = conversations.find((item) => item.id === original.id)!
    expect(migrated).toMatchObject({
      branch: 'feature/e2e-rollback',
      mode: 'worktree',
    })
    writeFileSync(path.join(migrated.cwd, 'after-migration.txt'), 'new work\n')
    await app.close()
    app = await launch(userData, 'e2e-migration-rollback')
    win = await app.firstWindow()
    await ready(win)
    expect(await win.evaluate(() => window.api.listConversationMigrationRecoveries())).toEqual([])
    const after = (await win.evaluate(() => window.api.listWorkspaces(true))).flatMap(
      (workspace) => workspace.conversations
    )
    expect(after.find((item) => item.id === original.id)).toMatchObject({
      cwd: migrated.cwd,
      branch: 'feature/e2e-rollback',
      mode: 'worktree',
    })
    expect(readFileSync(path.join(migrated.cwd, 'after-migration.txt'), 'utf8')).toBe('new work\n')
    expect(git(repo, ['status', '--porcelain'])).toBe('')
    expect(git(repo, ['stash', 'list'])).toBe('')
  } finally {
    if (app) await app.close().catch(() => {})
    // Electron helpers may briefly finish writing the profile after app.close().
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
