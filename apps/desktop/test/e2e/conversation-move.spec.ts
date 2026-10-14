import { execFileSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { desktop, fixtureModel, instanceEnv, launchHost, listen, portOf } from './helpers/remote-host'
import { removeTempDirEventually } from './helpers/temp-cleanup'

const HOST_ID = 'direct/host'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=E2E', '-c', 'user.email=e2e@test.local', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim()
}

/** Porcelain status of a checkout, sorted, the way two checkouts are compared. */
const status = (cwd: string): string =>
  execFileSync('git', ['status', '--porcelain=v2', '-z', '--untracked-files=all'], { cwd, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .sort()
    .join('\n')

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false
  )

/** A bare origin with `main`, and a clone whose `feature/move` branch has a commit the origin lacks. */
async function syntheticRepo(root: string): Promise<{ remote: string; work: string }> {
  const remote = path.join(root, 'remote.git')
  const seed = path.join(root, 'seed')
  git(root, 'init', '-q', '--bare', '-b', 'main', remote)
  await mkdir(seed)
  git(seed, 'init', '-q', '-b', 'main')
  for (const name of ['a.txt', 'b.txt']) await writeFile(path.join(seed, name), `${name} base\n`)
  git(seed, 'add', '-A')
  git(seed, 'commit', '-q', '-m', 'base')
  git(seed, 'remote', 'add', 'origin', remote)
  git(seed, 'push', '-q', 'origin', 'main')
  const work = path.join(root, 'work')
  git(root, 'clone', '-q', remote, work)
  git(work, 'checkout', '-q', '-b', 'feature/move')
  await writeFile(path.join(work, 'feature.txt'), 'unpushed work\n')
  git(work, 'add', 'feature.txt')
  git(work, 'commit', '-q', '-m', 'unpushed work')
  // The branch goes to a worktree of its own.
  git(work, 'checkout', '-q', 'main')
  return { remote, work }
}

// This computer and a workspaces host (the built app in server mode) on one machine: a conversation goes to the host
// through the dialog, with its history, notes and uncommitted work, and comes back through the API after work there.
test('conversation move: a conversation goes to a remote host and comes back', async () => {
  test.setTimeout(300_000)
  test.skip(process.platform === 'win32', 'The host side runs on Linux and macOS.')
  await access(path.join(desktop, 'out/main/index.js'))
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestrly-conversation-move-')))
  const model = fixtureModel()
  let host: ElectronApplication | undefined
  let client: ElectronApplication | undefined
  try {
    const { work } = await syntheticRepo(root)
    await listen(model.server)
    const workspacesRoot = path.join(root, 'srv')
    await mkdir(workspacesRoot)
    const launched = await launchHost(path.join(root, 'host-profile'), workspacesRoot)
    host = launched.app
    client = await electron.launch({
      args: [path.join(desktop, 'out/main/index.js')],
      env: {
        ...instanceEnv(path.join(root, 'client-profile'), 'conversation-move-client-e2e'),
        MAESTRLY_DEV_DIRECT_HOST: `http://${launched.token}@127.0.0.1:${launched.port}`,
      },
    })
    let page: Page = await client.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))
    await page.evaluate(() => (window as any).api.setOnboardingDone(true))
    const local = (name: string, ...args: unknown[]) =>
      page.evaluate(({ name, args }) => (window as any).api[name](...args), { name, args })
    const remote = (name: string, ...args: unknown[]) =>
      page.evaluate(({ hostId, name, args }) => (window as any).api.hostApi(hostId)[name](...args), {
        hostId: HOST_ID,
        name,
        args,
      })
    await expect
      .poll(async () => (await local('hostsList')).map((item: { state: string }) => item.state))
      .toEqual(['online', 'online'])

    // A conversation of this computer with a turn, a note, and work it has not committed.
    const provider = await local('chatAddProvider', {
      name: 'Move fixture',
      kind: 'openai',
      key: 'fixture-key',
      baseURL: `http://127.0.0.1:${portOf(model.server)}/v1`,
    })
    expect(provider.ok).toBe(true)
    const workspace = await local('addWorkspace', work)
    const conversation = await local('createConversation', {
      workspaceId: workspace.id,
      branch: 'feature/move',
      isNewBranch: false,
      mode: 'worktree',
    })
    expect(
      (await local('chatSetSelection', conversation.id, { providerId: provider.id, modelId: 'remote-fixture' })).ok
    ).toBe(true)
    expect((await local('chatSend', conversation.id, 'hello')).ok).toBe(true)
    await expect
      .poll(async () => (await local('chatHistoryPage', conversation.id)).messages.length, { timeout: 60_000 })
      .toBe(2)
    // The turn is over: the conversation no longer runs.
    await expect
      .poll(async () => (await local('listConversations', workspace.id))[0]?.status)
      .not.toMatch(/^(working|waiting|asking)$/)
    const note = await local('createNotePage', 'conv', conversation.id, { title: 'Move note' })
    await local('writeNotePage', 'conv', conversation.id, note.id, '# kept across hosts\n')
    const cwd: string = conversation.cwd
    await writeFile(path.join(cwd, 'a.txt'), 'a.txt staged\n')
    git(cwd, 'add', 'a.txt')
    await writeFile(path.join(cwd, 'b.txt'), 'b.txt unstaged\n')
    await writeFile(path.join(cwd, 'e.txt'), 'e.txt untracked\n')
    const head = git(cwd, 'rev-parse', 'HEAD')
    const before = status(cwd)

    // The sidebar lists the workspace added behind its back once it loads again.
    await page.reload()
    page = await client.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).api))

    const hostLabel = `127.0.0.1:${launched.port}`
    const row = page.locator('li.conv-item').filter({ hasText: 'feature/move' })
    await expect(row).toBeVisible()
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move to', exact: true }).click()
    await page.getByRole('menuitem', { name: hostLabel, exact: true }).click()
    await expect(page.getByRole('heading', { name: `Move conversation to ${hostLabel}` })).toBeVisible()
    await expect(page.getByText(/Will be cloned from/)).toBeVisible({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Move', exact: true }).click()
    await expect(page.getByText(`Conversation moved to ${hostLabel}`)).toBeVisible({ timeout: 120_000 })
    await page.getByRole('button', { name: 'Close', exact: true }).last().click()

    // On the host: the project was cloned into its workspaces folder, and the conversation kept its id and work.
    const hostWorkspaces = await remote('listWorkspaces')
    expect(hostWorkspaces.map((item: { path: string }) => item.path)).toEqual([path.join(workspacesRoot, 'remote')])
    const moved = hostWorkspaces[0].conversations.find((item: { id: string }) => item.id === conversation.id)
    expect(moved).toMatchObject({ branch: 'feature/move', mode: 'worktree' })
    expect((await remote('chatHistoryPage', conversation.id)).messages).toHaveLength(2)
    expect(git(moved.cwd, 'rev-parse', 'HEAD')).toBe(head)
    expect(status(moved.cwd)).toBe(before)
    expect(await readFile(path.join(moved.cwd, '.agents/notes', `${note.id}.md`), 'utf8')).toBe('# kept across hosts\n')

    // On this computer: the conversation and its worktree left; its branch and a backup of the moved work stay.
    expect((await local('listConversations', workspace.id)).map((item: { id: string }) => item.id)).not.toContain(
      conversation.id
    )
    expect(await exists(cwd)).toBe(false)
    expect(git(work, 'branch', '--list', 'feature/move')).toContain('feature/move')
    expect(git(work, 'for-each-ref', '--format=%(refname)', 'refs/maestrly/moved')).toMatch(/^refs\/maestrly\/moved\//)

    // Work continues on the host, and the conversation comes back.
    git(moved.cwd, 'commit', '-q', '-m', 'host work')
    const hostHead = git(moved.cwd, 'rev-parse', 'HEAD')
    const hostStatus = status(moved.cwd)
    const preview = await local('prepareConversationMove', {
      sourceHostId: HOST_ID,
      conversationId: conversation.id,
      targetHostId: 'local',
    })
    expect(preview.blockers).toEqual([])
    expect(preview.target).toMatchObject({ workspace: { kind: 'existing' }, branchAction: 'fast-forward' })
    const result = await local('executeConversationMove', {
      operationId: preview.operationId,
      selectedIgnoredPaths: [],
      confirmedSensitivePaths: [],
    })
    expect(result).toMatchObject({ status: 'completed', target: { hostId: 'local', conversationId: conversation.id } })

    const back = (await local('listConversations', workspace.id)).find(
      (item: { id: string }) => item.id === conversation.id
    )
    expect(back).toMatchObject({ branch: 'feature/move', mode: 'worktree' })
    expect(git(back.cwd, 'rev-parse', 'HEAD')).toBe(hostHead)
    expect(status(back.cwd)).toBe(hostStatus)
    expect((await local('chatHistoryPage', conversation.id)).messages).toHaveLength(2)
    expect(await readFile(path.join(back.cwd, '.agents/notes', `${note.id}.md`), 'utf8')).toBe('# kept across hosts\n')
    const hostAfter = await remote('listWorkspaces')
    expect(hostAfter[0].conversations.map((item: { id: string }) => item.id)).not.toContain(conversation.id)
    expect(await local('listConversationMoveRecoveries')).toEqual([])
  } finally {
    await client?.close().catch(() => undefined)
    await host?.close().catch(() => undefined)
    await new Promise((resolve) => model.server.close(resolve))
    await removeTempDirEventually(root)
  }
})
