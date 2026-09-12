import { _electron as electron } from '@playwright/test'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
const temporary = mkdtempSync(path.join(os.tmpdir(), 'maestrly-packaged-desktop-'))
const repo = path.join(temporary, 'project')
mkdirSync(repo)
for (const args of [
  ['init', '-q', '-b', 'main'],
  [
    '-c',
    'user.name=Desktop Test',
    '-c',
    'user.email=desktop@example.test',
    'commit',
    '--allow-empty',
    '-m',
    'test: initialize packaged desktop fixture',
  ],
])
  execFileSync('git', args, { cwd: repo })
const target =
  process.platform === 'darwin'
    ? path.join('dist', `mac-${process.arch}`, 'Maestrly App.app', 'Contents', 'MacOS', 'Maestrly App')
    : process.platform === 'win32'
      ? path.join('dist', process.arch === 'x64' ? 'win-unpacked' : `win-${process.arch}-unpacked`, 'Maestrly App.exe')
      : path.join('dist', process.arch === 'x64' ? 'linux-unpacked' : `linux-${process.arch}-unpacked`, 'maestrly-app')
const executablePath = path.resolve(process.argv[2] ?? target)
let app
let failure
const diagnostics = []
const launchTimeoutMs = process.platform === 'win32' ? 300_000 : 180_000
const deadline = setTimeout(() => app?.process().kill('SIGKILL'), launchTimeoutMs + 60_000)
deadline.unref()

async function removeTemporaryTree() {
  const expiresAt = Date.now() + 10000
  while (true) {
    try {
      await rm(temporary, { recursive: true, force: true })
      return
    } catch (error) {
      if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error?.code) || Date.now() >= expiresAt) throw error
      await delay(100)
    }
  }
}
try {
  app = await electron.launch({
    executablePath,
    timeout: launchTimeoutMs,
    args: process.platform === 'darwin' ? ['--use-mock-keychain'] : [],
    env: {
      ...process.env,
      AGENTS_E2E: '1',
      AGENTS_USERDATA: path.join(temporary, 'profile'),
      AGENTS_LOCALE: 'en',
      AGENTS_CHANNEL: 'prod',
      ELECTRON_RENDERER_URL: '',
    },
  })
  app.process().stderr.on('data', (chunk) => {
    diagnostics.push(String(chunk))
    if (diagnostics.length > 50) diagnostics.shift()
  })
  console.log('[packaged-desktop] PID:', app.process().pid)
  const page = await app.firstWindow()
  page.on('pageerror', (error) => diagnostics.push(error.message))
  console.log('[packaged-desktop] Window:', page.url())
  await page.waitForFunction(() => !!window.api, undefined, { timeout: 15000 })
  const identity = await app.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    name: app.getName(),
    profile: app.getPath('userData'),
  }))
  assert.equal(identity.packaged, true)
  assert.equal(identity.profile, path.join(temporary, 'profile'))
  const conversationId = await page.evaluate(async (repo) => {
    window.api.setOnboardingDone(true)
    const ws = await window.api.addWorkspace(repo)
    const preview = await window.api.prepareLocalConversation({
      workspaceId: ws.id,
      name: 'Packaged terminal check',
      intent: { type: 'switch-existing', branch: 'main', ref: { kind: 'local', name: 'main' } },
    })
    const result = await window.api.confirmLocalConversation({ token: preview.token })
    if (result.status !== 'created') throw new Error(JSON.stringify(result))
    window.api.drawerCreateTerminal(result.conversation.id)
    return result.conversation.id
  }, repo)
  await page.waitForFunction(async (id) => (await window.api.getTerminalState(id)).terminals.length > 0, conversationId)
  const terminalId = await page.evaluate(
    async (id) => (await window.api.getTerminalState(id)).terminals[0].id,
    conversationId
  )
  await page.evaluate((id) => window.api.writePty(id, 'echo MAESTRLY_TERMINAL_READY\r'), terminalId)
  await page.waitForFunction(
    async (id) => /[\r\n]MAESTRLY_TERMINAL_READY[\r\n]/.test((await window.api.readTerminal(id)).data),
    terminalId
  )
  console.log(
    JSON.stringify(
      {
        identity,
        terminal: 'Native PTY command executed successfully',
        localData: await page.evaluate(() => window.api.getLocalDataSummary()),
      },
      null,
      2
    )
  )
  await page.evaluate(({ conversationId, terminalId }) => window.api.drawerCloseTerminal(conversationId, terminalId), {
    conversationId,
    terminalId,
  })
  await page.waitForFunction(
    async ({ conversationId, terminalId }) =>
      !(await window.api.getTerminalState(conversationId)).terminals.some((terminal) => terminal.id === terminalId),
    { conversationId, terminalId }
  )
} catch (error) {
  console.error('[packaged-desktop] Diagnostics:', diagnostics.join('\n'))
  failure = error
} finally {
  clearTimeout(deadline)
  try {
    if (app) {
      const stopped = await Promise.race([app.close().then(() => true), delay(10000, false, { ref: false })])
      if (!stopped) {
        console.error('[packaged-desktop] Shutdown diagnostics:', diagnostics.join('\n'))
        console.error('[packaged-desktop] Process state:', {
          exitCode: app.process().exitCode,
          signalCode: app.process().signalCode,
          killed: app.process().killed,
        })
        app.process().kill('SIGKILL')
        failure ??= new Error('Packaged desktop shutdown exceeded 10 seconds')
      }
    }
  } catch (error) {
    app?.process().kill('SIGKILL')
    failure ??= error
  }
  try {
    await removeTemporaryTree()
  } catch (error) {
    failure ??= error
  }
}
if (failure) throw failure
