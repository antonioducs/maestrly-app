import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
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
const instanceId = 'e2e-project-setup'
declare const window: { api?: unknown }

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function launch(
  userData: string,
  pickers: string[],
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
      AGENTS_E2E_PROJECT_PICKERS: JSON.stringify(pickers),
      ELECTRON_RENDERER_URL: '',
      ...envOverrides,
    },
  })
}

async function skipOnboarding(win: Awaited<ReturnType<ElectronApplication['firstWindow']>>) {
  await win.waitForFunction(() => typeof window.api !== 'undefined')
  const skip = win.getByRole('button', { name: 'Skip' })
  if (await skip.isVisible().catch(() => false)) await skip.click()
}

async function openSetupFromSidebar(win: Awaited<ReturnType<ElectronApplication['firstWindow']>>) {
  await win.getByRole('button', { name: 'Add workspace' }).click()
  await expect(win.getByRole('heading', { name: 'Add project' })).toBeVisible()
}

async function chooseFolder(win: Awaited<ReturnType<ElectronApplication['firstWindow']>>) {
  await win.getByRole('button', { name: 'Choose…' }).click()
}

async function waitForWorkspace(win: Awaited<ReturnType<ElectronApplication['firstWindow']>>, name: string) {
  await expect(win.locator(`[data-workspace-id]`).filter({ hasText: name })).toBeVisible()
}

test('Sidebar: opens and deduplicates Git projects, initializes existing folders, and creates usable projects', async () => {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'agents-e2e-project-')))
  const userData = path.join(root, 'ud')
  mkdirSync(userData)
  const repo = path.join(root, 'existing-repo')
  mkdirSync(repo)
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.name', 'E2E'])
  git(repo, ['config', 'user.email', 'e2e@test.local'])
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'init'])
  const customer = path.join(root, 'customer-folder')
  mkdirSync(customer)
  writeFileSync(path.join(customer, 'keep.txt'), 'keep')

  const app = await launch(userData, [repo, repo, customer, root])
  try {
    const win = await app.firstWindow()
    await skipOnboarding(win)

    await openSetupFromSidebar(win)
    await chooseFolder(win)
    await win.getByRole('button', { name: 'Open project' }).click()
    await waitForWorkspace(win, 'existing-repo')

    // Same path: reuse and focus the project without a duplicate row.
    await openSetupFromSidebar(win)
    await chooseFolder(win)
    await win.getByRole('button', { name: 'Open project' }).click()
    await expect(win.locator('[data-workspace-id]').filter({ hasText: 'existing-repo' })).toHaveCount(1)

    await openSetupFromSidebar(win)
    await chooseFolder(win)
    await win.getByRole('button', { name: 'Open project' }).click()
    await expect(win.getByText('This folder has no usable Git history.')).toBeVisible()
    expect(existsSync(path.join(customer, '.git'))).toBe(false)
    await win.getByRole('button', { name: 'Initialize Git in this folder' }).click()
    await waitForWorkspace(win, 'customer-folder')
    expect(git(customer, ['status', '--porcelain'])).toBe('?? keep.txt')

    await openSetupFromSidebar(win)
    await win.getByRole('button', { name: 'Create new' }).click()
    await chooseFolder(win)
    await win.getByLabel('Project name').fill('fresh-project')
    await win.getByRole('button', { name: 'Create project' }).click()
    await waitForWorkspace(win, 'fresh-project')
    const fresh = path.join(root, 'fresh-project')
    expect(git(fresh, ['branch', '--show-current'])).toBe('main')
    expect(git(fresh, ['show', '--pretty=', '--name-only', 'HEAD'])).toBe('README.md')
    expect(readFileSync(path.join(fresh, 'README.md'), 'utf8')).toBe('# fresh-project\n')
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('closing the modal during cloning cancels the process tree, waits for cleanup, and does not register a workspace', async () => {
  test.skip(process.platform === 'win32', 'This stall fixture requires a POSIX executable and shell.')
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'agents-e2e-cancel-')))
  const userData = path.join(root, 'ud')
  const bin = path.join(root, 'bin')
  const remote = path.join(root, 'remote.git')
  mkdirSync(userData)
  mkdirSync(bin)
  git(root, ['init', '-q', '--bare', '--initial-branch=main', remote])
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  const shim = path.join(bin, 'git')
  writeFileSync(
    shim,
    `#!/bin/sh\ncase " $* " in\n  *" clone "*)\n    dest=""\n    for arg in "$@"; do dest="$arg"; done\n    mkdir -p "$dest"\n    echo "Receiving objects: 25%" >&2\n    trap 'exit 143' TERM INT\n    while :; do sleep 1; done\n    ;;\n  *) exec "${realGit}" "$@" ;;\nesac\n`
  )
  chmodSync(shim, 0o755)

  const app = await launch(userData, [root], { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` })
  try {
    const win = await app.firstWindow()
    await skipOnboarding(win)
    await openSetupFromSidebar(win)
    await win.getByRole('button', { name: 'Clone Git repository' }).click()
    await win.getByLabel('Git URL').fill(remote)
    await chooseFolder(win)
    await win.getByLabel('Project name').fill('cancel-me')
    await win.getByRole('button', { name: 'Clone repository' }).click()
    // Regression: closing on the first tick after submit must not lose cancellation through stale React state.
    await win.keyboard.press('Escape')
    // Cancellation can finish before the transient cleanup message is painted.
    await expect
      .poll(
        async () =>
          (await win.getByText('Canceling and cleaning up…').isVisible()) ||
          (await win.getByRole('heading', { name: 'Add project' }).count()) === 0
      )
      .toBe(true)
    await expect(win.getByRole('heading', { name: 'Add project' })).toHaveCount(0)
    expect(existsSync(path.join(root, 'cancel-me'))).toBe(false)
    await expect(win.locator('[data-workspace-id]').filter({ hasText: 'cancel-me' })).toHaveCount(0)
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('Sidebar: cloning honors develop; an empty remote can be rejected or accepted without pushing; New conversation reuses the modal', async () => {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'agents-e2e-clone-')))
  const userData = path.join(root, 'ud')
  mkdirSync(userData)
  const source = path.join(root, 'source')
  const remote = path.join(root, 'remote.git')
  mkdirSync(source)
  git(source, ['init', '-q', '-b', 'develop'])
  git(source, ['config', 'user.name', 'E2E'])
  git(source, ['config', 'user.email', 'e2e@test.local'])
  writeFileSync(path.join(source, 'code.txt'), 'code')
  git(source, ['add', 'code.txt'])
  git(source, ['commit', '-q', '-m', 'init'])
  git(root, ['clone', '-q', '--bare', source, remote])
  const empty = path.join(root, 'empty.git')
  git(root, ['init', '-q', '--bare', '--initial-branch=main', empty])

  const app = await launch(userData, [root, root, root, root])
  try {
    const win = await app.firstWindow()
    await skipOnboarding(win)

    await openSetupFromSidebar(win)
    await win.getByRole('button', { name: 'Clone Git repository' }).click()
    await win.getByLabel('Git URL').fill(remote)
    await chooseFolder(win)
    await win.getByRole('button', { name: 'Clone repository' }).click()
    await waitForWorkspace(win, 'remote')
    expect(git(path.join(root, 'remote'), ['branch', '--show-current'])).toBe('develop')

    await openSetupFromSidebar(win)
    await win.getByRole('button', { name: 'Clone Git repository' }).click()
    await win.getByLabel('Git URL').fill(empty)
    await chooseFolder(win)
    await win.getByLabel('Project name').fill('empty-refused')
    await win.getByRole('button', { name: 'Clone repository' }).click()
    await expect(win.getByText('This remote is empty.')).toBeVisible()
    await win.getByRole('button', { name: 'Cancel and remove clone' }).click()
    await expect(win.getByRole('heading', { name: 'Add project' })).toHaveCount(0)
    expect(existsSync(path.join(root, 'empty-refused'))).toBe(false)

    await openSetupFromSidebar(win)
    await win.getByRole('button', { name: 'Clone Git repository' }).click()
    await win.getByLabel('Git URL').fill(empty)
    await chooseFolder(win)
    await win.getByLabel('Project name').fill('empty-accepted')
    await win.getByRole('button', { name: 'Clone repository' }).click()
    await win.getByRole('button', { name: 'Initialize local copy' }).click()
    await waitForWorkspace(win, 'empty-accepted')
    expect(git(root, ['ls-remote', empty])).toBe('')

    // Multi-repository entry opens the same modal over New conversation.
    await expect(win.getByRole('heading', { name: 'Add project' })).toHaveCount(0)
    const remoteWorkspace = win.locator('[data-workspace-id]').filter({ hasText: 'remote' })
    await remoteWorkspace.locator('[data-workspace-header]').hover()
    await remoteWorkspace.getByTitle('New conversation').click()
    await win.getByRole('button', { name: 'Add repo' }).click()
    await win.getByRole('menuitem', { name: 'Choose folder…' }).click()
    await expect(win.getByRole('heading', { name: 'Add project' })).toBeVisible()
  } finally {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  }
})
